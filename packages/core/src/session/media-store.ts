export * as SessionMediaStore from "./media-store.js"

import { join, dirname, basename } from "path"
import { mkdir, writeFile, readdir, readFile } from "fs/promises"
import { Hash } from "@opencode/util/hash"
import { Effect } from "effect"

// Images sent to text-only models are persisted here so the model can query
// them later via the describe_image tool, without the bytes reaching a model
// that cannot read them. The handle is content-addressed, so the same image is
// stored only once.
export const CACHE_DIRECTORY = ".opencode/cache/media"

export type Handle = string & { readonly Handle: unique symbol }

export const makeHandle = (value: string) => value as Handle

export const mediaPath = (projectDirectory: string, handle: string) =>
  join(projectDirectory, CACHE_DIRECTORY, handle)

// A model may pass the handle back missing its extension (for example dropping
// the trailing `.png`), so a straight `readFile(mediaPath(...))` would miss an
// image that is actually on disk. Handles are content-addressed — the hash body
// is globally unique — so resolving by hash prefix recovers the real file name
// without ambiguity. Returns `undefined` when no stored image matches.
export const resolveFile = async (
  projectDirectory: string,
  handle: string,
): Promise<string | undefined> => {
  const exact = mediaPath(projectDirectory, handle)
  try {
    await readFile(exact)
    return exact
  } catch {
    const dir = mediaPath(projectDirectory, "")
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return undefined
    }
    const stem = `${basename(handle)}.`
    const match = entries.find((entry) => entry.startsWith(stem))
    return match === undefined ? undefined : mediaPath(projectDirectory, match)
  }
}

// A stable label for the model to reason about a stored image.
export const describeReference = (handle: string, title: string) =>
  [
    `[Attached image stored as ${handle}]`,
    `Title: ${title}`,
    `The image was saved to the project cache because the current model cannot read images directly.`,
    `Call the \`describe_image\` tool with this handle and a specific question to inspect it.`,
  ].join("\n")

// Best-effort write: failures resolve to `undefined` so an image whose bytes
// cannot be persisted simply falls through to the normal unsupported-media
// path instead of failing the whole request.
export const storeImage = (input: {
  projectDirectory: string
  mime: string
  bytes: Uint8Array
}): Effect.Effect<Handle | undefined> =>
  Effect.tryPromise({
    try: async () => {
      const name = `${Hash.sha256(Buffer.from(input.bytes))}${extension(input.mime)}`
      const target = mediaPath(input.projectDirectory, name)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, input.bytes)
      return makeHandle(name)
    },
    catch: () => undefined as never,
  }).pipe(Effect.orElseSucceed(() => undefined))

function extension(mime: string): string {
  const lower = mime.toLowerCase()
  if (lower.includes("png")) return ".png"
  if (lower.includes("jpeg") || lower.includes("jpg")) return ".jpg"
  if (lower.includes("gif")) return ".gif"
  if (lower.includes("webp")) return ".webp"
  if (lower.includes("pdf")) return ".pdf"
  if (lower.includes("svg")) return ".svg"
  return ""
}
