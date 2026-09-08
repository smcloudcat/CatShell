import { create } from 'zustand'
import { load } from '@tauri-apps/plugin-store'
import { CommandSnippet, createCommandSnippet } from '../types/snippet'

const STORE_FILE = 'command-snippets.json'
const SNIPPETS_KEY = 'snippets'

interface SnippetsState {
  ready: boolean
  snippets: CommandSnippet[]
  init: () => Promise<void>
  upsert: (snippet: CommandSnippet) => Promise<void>
  remove: (id: string) => Promise<void>
  importSnippets: (snippets: Partial<CommandSnippet>[]) => Promise<void>
}

let initPromise: Promise<void> | null = null

async function persist(snippets: CommandSnippet[]) {
  try {
    const store = await load(STORE_FILE)
    await store.set(SNIPPETS_KEY, snippets)
    await store.save()
  } catch {
    localStorage.setItem(SNIPPETS_KEY, JSON.stringify(snippets))
  }
}

function normalize(value: Partial<CommandSnippet>): CommandSnippet {
  return createCommandSnippet({
    ...value,
    name: typeof value.name === 'string' ? value.name.trim() : '',
    command: typeof value.command === 'string' ? value.command.trim() : '',
    description: typeof value.description === 'string' ? value.description.trim() : '',
    updatedAt: Date.now()
  })
}

export const useSnippets = create<SnippetsState>((set, get) => ({
  ready: false,
  snippets: [],
  init: async () => {
    if (get().ready) return
    if (initPromise) return initPromise
    initPromise = (async () => {
      let stored: unknown = null
      try {
        const store = await load(STORE_FILE)
        stored = await store.get<unknown>(SNIPPETS_KEY)
      } catch {
        const raw = localStorage.getItem(SNIPPETS_KEY)
        if (raw) {
          try {
            stored = JSON.parse(raw)
          } catch {
            stored = null
          }
        }
      }
      const snippets = Array.isArray(stored)
        ? stored
            .filter((item): item is Partial<CommandSnippet> => Boolean(item && typeof item === 'object'))
            .map((item) => normalize(item))
            .filter((item) => item.name && item.command)
        : []
      set({ snippets, ready: true })
    })()
    try {
      await initPromise
    } finally {
      initPromise = null
    }
  },
  upsert: async (snippet) => {
    const next = normalize(snippet)
    if (!next.name || !next.command) throw new Error('片段名称和命令不能为空')
    const snippets = get().snippets.some((item) => item.id === next.id)
      ? get().snippets.map((item) => (item.id === next.id ? next : item))
      : [next, ...get().snippets]
    set({ snippets })
    await persist(snippets)
  },
  remove: async (id) => {
    const snippets = get().snippets.filter((item) => item.id !== id)
    set({ snippets })
    await persist(snippets)
  },
  importSnippets: async (values) => {
    const imported = values
      .filter((item): item is Partial<CommandSnippet> => Boolean(item && typeof item === 'object'))
      .map((item) => normalize(item))
      .filter((item) => item.name && item.command)
    const byId = new Map(get().snippets.map((item) => [item.id, item]))
    for (const snippet of imported) byId.set(snippet.id, snippet)
    const snippets = Array.from(byId.values())
    set({ snippets })
    await persist(snippets)
  }
}))
