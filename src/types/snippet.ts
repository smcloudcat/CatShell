export interface CommandSnippet {
  id: string
  name: string
  command: string
  description: string
  updatedAt: number
}

const PARAMETER_PATTERN = /\{\{\s*([A-Za-z][A-Za-z0-9_-]*)\s*\}\}/g

export function getSnippetParameters(command: string): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const match of command.matchAll(PARAMETER_PATTERN)) {
    const name = match[1]
    if (!seen.has(name)) {
      names.push(name)
      seen.add(name)
    }
  }
  return names
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

export function renderCommandTemplate(command: string, values: Record<string, string>): string {
  return command.replace(PARAMETER_PATTERN, (_match, name: string) => shellQuote(values[name] ?? ''))
}

export function createCommandSnippet(partial: Partial<CommandSnippet> = {}): CommandSnippet {
  return {
    id: crypto.randomUUID(),
    name: '',
    command: '',
    description: '',
    updatedAt: Date.now(),
    ...partial
  }
}
