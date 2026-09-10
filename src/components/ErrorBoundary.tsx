import { Component, ReactNode } from 'react'
import { t } from '../i18n'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('界面渲染发生未捕获错误', error)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          padding: 24,
          background: 'var(--bg, #0b1220)',
          color: 'inherit'
        }}
      >
        <h1 style={{ fontSize: 20, margin: 0 }}>{t('界面发生错误')}</h1>
        <pre style={{ maxWidth: 720, whiteSpace: 'pre-wrap', wordBreak: 'break-all', opacity: 0.8 }}>
          {this.state.error.message}
        </pre>
        <button onClick={() => window.location.reload()}>{t('重新加载')}</button>
      </div>
    )
  }
}