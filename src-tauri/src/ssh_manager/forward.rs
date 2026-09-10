use std::sync::Arc;
use std::time::Duration;

use russh::client;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use super::monitor::validate_network_target;
use super::types::PortForwardInfo;
use super::{ForwardChildren, SshHandler, SshManager};

#[derive(Clone, Debug)]
pub(super) struct RemoteForwardRoute {
    pub(super) target_host: String,
    pub(super) target_port: u16,
}

#[derive(Clone, Debug)]
pub(super) struct RemoteForwardInfo {
    pub(super) session_id: u64,
    pub(super) bind_host: String,
    pub(super) bind_port: u16,
    pub(super) requested_port: u16,
}

async fn read_socks_target(stream: &mut TcpStream) -> Result<(String, u16), u8> {
    let mut greeting = [0_u8; 2];
    stream.read_exact(&mut greeting).await.map_err(|_| 0x01)?;
    if greeting[0] != 0x05 || greeting[1] == 0 || greeting[1] > 32 {
        return Err(0x01);
    }
    let mut methods = vec![0_u8; greeting[1] as usize];
    stream.read_exact(&mut methods).await.map_err(|_| 0x01)?;
    if !methods.contains(&0x00) {
        let _ = stream.write_all(&[0x05, 0xff]).await;
        return Err(0xff);
    }
    stream.write_all(&[0x05, 0x00]).await.map_err(|_| 0x01)?;

    let mut request = [0_u8; 4];
    stream.read_exact(&mut request).await.map_err(|_| 0x01)?;
    if request[0] != 0x05 || request[2] != 0x00 {
        return Err(0x01);
    }
    if request[1] != 0x01 {
        return Err(0x07);
    }
    let host = match request[3] {
        0x01 => {
            let mut address = [0_u8; 4];
            stream.read_exact(&mut address).await.map_err(|_| 0x01)?;
            std::net::Ipv4Addr::from(address).to_string()
        }
        0x03 => {
            let length = stream.read_u8().await.map_err(|_| 0x01)? as usize;
            if length == 0 {
                return Err(0x08);
            }
            let mut address = vec![0_u8; length];
            stream.read_exact(&mut address).await.map_err(|_| 0x01)?;
            let address = String::from_utf8(address).map_err(|_| 0x08)?;
            validate_network_target(&address).map_err(|_| 0x08)?
        }
        0x04 => {
            let mut address = [0_u8; 16];
            stream.read_exact(&mut address).await.map_err(|_| 0x01)?;
            std::net::Ipv6Addr::from(address).to_string()
        }
        _ => return Err(0x08),
    };
    let port = stream.read_u16().await.map_err(|_| 0x01)?;
    if port == 0 {
        return Err(0x01);
    }
    Ok((host, port))
}

async fn write_socks_reply(stream: &mut TcpStream, status: u8) {
    let _ = stream
        .write_all(&[0x05, status, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
        .await;
}

impl SshManager {
    /// 登记一个转发子任务，顺带剔除已结束的句柄，避免句柄表无界增长。
    async fn track_forward_child(children: &ForwardChildren, handle: JoinHandle<()>) {
        let mut guard = children.lock().await;
        guard.retain(|handle| !handle.is_finished());
        guard.push(handle);
    }

    /// abort 一条转发下所有在飞连接（P2-6）。
    ///
    /// 只 abort listener 只能停止接受新连接，已经建立的隧道会一直存活到对端关闭，
    /// 用户看到的是「转发已停止但连接还在」。这里连同子任务一起终止。
    async fn abort_forward_children(&self, forward_id: u64) {
        let children = self.forward_children.lock().await.remove(&forward_id);
        if let Some(children) = children {
            for handle in children.lock().await.drain(..) {
                handle.abort();
            }
        }
    }

    pub async fn start_local_forward(
        &self,
        manager: std::sync::Arc<SshManager>,
        session_id: u64,
        bind_host: String,
        bind_port: u16,
        target_host: String,
        target_port: u16,
    ) -> Result<PortForwardInfo, String> {
        let bind_host = bind_host.trim().to_string();
        if bind_host != "127.0.0.1" && bind_host != "localhost" && bind_host != "::1" {
            return Err("本地转发只允许绑定回环地址".to_string());
        }
        let target_host = validate_network_target(&target_host)?;
        if target_port == 0 {
            return Err("目标端口无效".to_string());
        }
        {
            let session = self.session_ref(session_id).await?;
            if session.conn.lock().await.is_none() {
                return Err("会话尚未连接".to_string());
            }
        }
        let listener = TcpListener::bind((bind_host.as_str(), bind_port))
            .await
            .map_err(|error| format!("绑定本地端口失败: {error}"))?;
        let actual_port = listener
            .local_addr()
            .map_err(|error| format!("读取本地端口失败: {error}"))?
            .port();
        let id = self
            .next_forward_id
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let info = PortForwardInfo {
            id,
            session_id,
            direction: "local".to_string(),
            bind_host: bind_host.clone(),
            bind_port: actual_port,
            target_host: target_host.clone(),
            target_port,
        };
        let task_info = info.clone();
        let children: ForwardChildren = Arc::new(Mutex::new(Vec::new()));
        let task_children = children.clone();
        let task = tokio::spawn(async move {
            let session_id = task_info.session_id;
            let target_host = task_info.target_host.clone();
            let target_port = task_info.target_port;
            loop {
                let (local, _) = match listener.accept().await {
                    Ok(connection) => connection,
                    Err(_) => break,
                };
                let manager = manager.clone();
                let target_host = target_host.clone();
                let handle = tokio::spawn(async move {
                    let channel = {
                        let Ok(session) = manager.session_ref(session_id).await else {
                            return;
                        };
                        let mut connection = session.conn.lock().await;
                        let Some(connection) = connection.as_mut() else {
                            return;
                        };
                        match connection
                            .channel_open_direct_tcpip(
                                &target_host,
                                target_port as u32,
                                "127.0.0.1",
                                0,
                            )
                            .await
                        {
                            Ok(channel) => channel,
                            Err(_) => return,
                        }
                    };
                    let mut remote = channel.into_stream();
                    let mut local = local;
                    let _ = tokio::io::copy_bidirectional(&mut local, &mut remote).await;
                });
                SshManager::track_forward_child(&task_children, handle).await;
            }
            // listener 主动退出（accept 失败）时同样收束在飞连接，避免任务表泄漏。
            manager.abort_forward_children(task_info.id).await;
        });
        self.forwards.lock().await.insert(id, task);
        self.forward_children.lock().await.insert(id, children);
        self.forward_info.lock().await.insert(id, info.clone());
        Ok(info)
    }

    pub async fn start_remote_forward(
        &self,
        session_id: u64,
        bind_host: String,
        bind_port: u16,
        target_host: String,
        target_port: u16,
    ) -> Result<PortForwardInfo, String> {
        let bind_host = bind_host.trim().to_string();
        if bind_host != "127.0.0.1" && bind_host != "localhost" {
            return Err("远程转发只允许监听远端回环地址".to_string());
        }
        let target_host = validate_network_target(&target_host)?;
        if target_port == 0 {
            return Err("目标端口无效".to_string());
        }
        let session = self.session_ref(session_id).await?;
        let actual_port = {
            let mut connection = session.conn.lock().await;
            let connection = connection
                .as_mut()
                .ok_or_else(|| "会话尚未连接".to_string())?;
            let port = connection
                .tcpip_forward(bind_host.clone(), bind_port as u32)
                .await
                .map_err(|error| format!("请求远程端口转发失败: {error}"))?;
            u16::try_from(if port == 0 { bind_port as u32 } else { port })
                .map_err(|_| "远程端口无效".to_string())?
        };
        if actual_port == 0 {
            return Err("远程服务器未返回有效监听端口".to_string());
        }

        let id = self
            .next_forward_id
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.remote_routes.lock().await.insert(
            (session_id, actual_port),
            RemoteForwardRoute {
                target_host: target_host.clone(),
                target_port,
            },
        );
        self.remote_forwards.lock().await.insert(
            id,
            RemoteForwardInfo {
                session_id,
                bind_host: bind_host.clone(),
                bind_port: actual_port,
                requested_port: bind_port,
            },
        );
        let info = PortForwardInfo {
            id,
            session_id,
            direction: "remote".to_string(),
            bind_host,
            bind_port: actual_port,
            target_host,
            target_port,
        };
        self.forward_info.lock().await.insert(id, info.clone());
        Ok(info)
    }

    pub async fn start_dynamic_forward(
        &self,
        manager: std::sync::Arc<SshManager>,
        session_id: u64,
        bind_host: String,
        bind_port: u16,
    ) -> Result<PortForwardInfo, String> {
        let bind_host = bind_host.trim().to_string();
        if bind_host != "127.0.0.1" && bind_host != "localhost" && bind_host != "::1" {
            return Err("动态转发只允许绑定回环地址".to_string());
        }
        {
            let session = self.session_ref(session_id).await?;
            if session.conn.lock().await.is_none() {
                return Err("会话尚未连接".to_string());
            }
        }
        let listener = TcpListener::bind((bind_host.as_str(), bind_port))
            .await
            .map_err(|error| format!("绑定 SOCKS5 端口失败: {error}"))?;
        let actual_port = listener
            .local_addr()
            .map_err(|error| format!("读取 SOCKS5 端口失败: {error}"))?
            .port();
        let id = self
            .next_forward_id
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let info = PortForwardInfo {
            id,
            session_id,
            direction: "dynamic".to_string(),
            bind_host: bind_host.clone(),
            bind_port: actual_port,
            target_host: "SOCKS5".to_string(),
            target_port: 0,
        };
        let task_info = info.clone();
        let children: ForwardChildren = Arc::new(Mutex::new(Vec::new()));
        let task_children = children.clone();
        let task = tokio::spawn(async move {
            let session_id = task_info.session_id;
            loop {
                let (mut local, peer) = match listener.accept().await {
                    Ok(connection) => connection,
                    Err(_) => break,
                };
                let manager = manager.clone();
                let handle = tokio::spawn(async move {
                    let (target_host, target_port) = match tokio::time::timeout(
                        Duration::from_secs(10),
                        read_socks_target(&mut local),
                    )
                    .await
                    {
                        Ok(Ok(target)) => target,
                        Ok(Err(status)) => {
                            if status != 0xff {
                                write_socks_reply(&mut local, status).await;
                            }
                            return;
                        }
                        Err(_) => {
                            write_socks_reply(&mut local, 0x01).await;
                            return;
                        }
                    };
                    let channel = {
                        let Ok(session) = manager.session_ref(session_id).await else {
                            write_socks_reply(&mut local, 0x01).await;
                            return;
                        };
                        let mut connection = session.conn.lock().await;
                        let Some(connection) = connection.as_mut() else {
                            write_socks_reply(&mut local, 0x01).await;
                            return;
                        };
                        match connection
                            .channel_open_direct_tcpip(
                                &target_host,
                                target_port as u32,
                                peer.ip().to_string(),
                                peer.port() as u32,
                            )
                            .await
                        {
                            Ok(channel) => channel,
                            Err(_) => {
                                write_socks_reply(&mut local, 0x05).await;
                                return;
                            }
                        }
                    };
                    write_socks_reply(&mut local, 0x00).await;
                    let mut remote = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut local, &mut remote).await;
                });
                SshManager::track_forward_child(&task_children, handle).await;
            }
            manager.abort_forward_children(task_info.id).await;
        });
        self.forwards.lock().await.insert(id, task);
        self.forward_children.lock().await.insert(id, children);
        self.forward_info.lock().await.insert(id, info.clone());
        Ok(info)
    }

    pub async fn list_local_forwards(&self) -> Vec<PortForwardInfo> {
        self.forward_info.lock().await.values().cloned().collect()
    }

    pub async fn stop_forward(&self, id: u64) -> Result<(), String> {
        // 先收束该转发下的在飞连接，再停 listener（P2-6）。
        self.abort_forward_children(id).await;
        if let Some(task) = self.forwards.lock().await.remove(&id) {
            task.abort();
            self.forward_info.lock().await.remove(&id);
            return Ok(());
        }

        let remote = self
            .remote_forwards
            .lock()
            .await
            .remove(&id)
            .ok_or_else(|| "端口转发不存在".to_string())?;
        let cancel_result = {
            let session = self.session_ref(remote.session_id).await.ok();
            if let Some(session) = session {
                let mut connection = session.conn.lock().await;
                if let Some(connection) = connection.as_mut() {
                    Some(
                        connection
                            .cancel_tcpip_forward(remote.bind_host.clone(), remote.bind_port as u32)
                            .await
                            .map_err(|error| format!("停止远程端口转发失败: {error}")),
                    )
                } else {
                    None
                }
            } else {
                None
            }
        };
        if let Some(Err(error)) = cancel_result {
            self.remote_forwards.lock().await.insert(id, remote);
            return Err(error);
        }
        self.remote_routes
            .lock()
            .await
            .remove(&(remote.session_id, remote.bind_port));
        self.forward_info.lock().await.remove(&id);
        Ok(())
    }

    pub(super) async fn restore_remote_forwards(
        &self,
        session_id: u64,
        connection: &mut client::Handle<SshHandler>,
    ) -> Result<(), String> {
        let forwards: Vec<(u64, RemoteForwardInfo)> = self
            .remote_forwards
            .lock()
            .await
            .iter()
            .filter(|(_, info)| info.session_id == session_id)
            .map(|(id, info)| (*id, info.clone()))
            .collect();
        for (id, info) in forwards {
            let port = connection
                .tcpip_forward(info.bind_host.clone(), info.requested_port as u32)
                .await
                .map_err(|error| format!("恢复远程端口转发失败: {error}"))?;
            let actual_port = u16::try_from(if port == 0 {
                info.requested_port as u32
            } else {
                port
            })
            .map_err(|_| "恢复远程端口无效".to_string())?;
            let mut remote_forwards = self.remote_forwards.lock().await;
            let Some(current) = remote_forwards.get_mut(&id) else {
                continue;
            };
            let old_port = current.bind_port;
            current.bind_port = actual_port;
            drop(remote_forwards);
            let mut routes = self.remote_routes.lock().await;
            let route = routes.remove(&(session_id, old_port));
            if let Some(info) = self.forward_info.lock().await.get_mut(&id) {
                info.bind_port = actual_port;
            }
            // The route target is kept under the new server-assigned port.
            if let Some(route) = route {
                routes.insert((session_id, actual_port), route);
            }
        }
        Ok(())
    }

    pub(super) async fn stop_forwards_for_session(&self, session_id: u64) {
        let ids: Vec<u64> = self
            .forward_info
            .lock()
            .await
            .values()
            .filter(|info| info.session_id == session_id)
            .map(|info| info.id)
            .collect();
        for id in ids {
            let _ = self.stop_forward(id).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::read_socks_target;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    #[tokio::test]
    async fn parses_socks5_domain_connect_request() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(address).await.unwrap();
            stream.write_all(&[0x05, 0x01, 0x00]).await.unwrap();
            let mut response = [0_u8; 2];
            stream.read_exact(&mut response).await.unwrap();
            assert_eq!(response, [0x05, 0x00]);
            stream
                .write_all(&[
                    0x05, 0x01, 0x00, 0x03, 0x0b, b'e', b'x', b'a', b'm', b'p', b'l', b'e', b'.',
                    b'c', b'o', b'm', 0x01, 0xbb,
                ])
                .await
                .unwrap();
        });
        let (mut stream, _) = listener.accept().await.unwrap();
        let target = read_socks_target(&mut stream).await.unwrap();
        assert_eq!(target, ("example.com".to_string(), 443));
        client.await.unwrap();
    }

    #[tokio::test]
    async fn rejects_unsupported_socks5_command() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(address).await.unwrap();
            stream.write_all(&[0x05, 0x01, 0x00]).await.unwrap();
            let mut response = [0_u8; 2];
            stream.read_exact(&mut response).await.unwrap();
            stream
                .write_all(&[0x05, 0x03, 0x00, 0x01, 127, 0, 0, 1, 0, 53])
                .await
                .unwrap();
        });
        let (mut stream, _) = listener.accept().await.unwrap();
        assert_eq!(read_socks_target(&mut stream).await.unwrap_err(), 0x07);
        client.await.unwrap();
    }
}
