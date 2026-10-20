import { test, expect } from "bun:test"
import { mkdir, writeFile } from "fs/promises"
import path from "path"
import { SessionMediaStore } from "../../src/session/media-store.js"
import { tmpdir } from "../fixture/tmpdir"

test("resolveFile returns the exact path when the handle already includes its extension", async () => {
  await using tmp = await tmpdir()
  const dir = path.join(tmp.path, SessionMediaStore.CACHE_DIRECTORY)
  await mkdir(dir, { recursive: true })
  const handle = "abc123.png"
  await writeFile(path.join(dir, handle), "png-bytes")

  const resolved = await SessionMediaStore.resolveFile(tmp.path, handle)
  expect(resolved).toBe(path.join(dir, handle))
})

test("resolveFile recovers the real file name when the handle drops its extension", async () => {
  await using tmp = await tmpdir()
  const dir = path.join(tmp.path, SessionMediaStore.CACHE_DIRECTORY)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, "abc123.png"), "png-bytes")

  const resolved = await SessionMediaStore.resolveFile(tmp.path, "abc123")
  expect(resolved).toBe(path.join(dir, "abc123.png"))
})

test("resolveFile returns undefined when no stored image matches", async () => {
  await using tmp = await tmpdir()
  const dir = path.join(tmp.path, SessionMediaStore.CACHE_DIRECTORY)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, "other.png"), "png-bytes")

  const resolved = await SessionMediaStore.resolveFile(tmp.path, "abc123")
  expect(resolved).toBeUndefined()
})

test("resolveFile returns undefined when the media cache directory does not exist", async () => {
  await using tmp = await tmpdir()
  const resolved = await SessionMediaStore.resolveFile(tmp.path, "abc123")
  expect(resolved).toBeUndefined()
})

test("resolveFile does not match a handle that is only a prefix of another hash", async () => {
  await using tmp = await tmpdir()
  const dir = path.join(tmp.path, SessionMediaStore.CACHE_DIRECTORY)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, "abc1234.png"), "png-bytes")

  const resolved = await SessionMediaStore.resolveFile(tmp.path, "abc123")
  expect(resolved).toBeUndefined()
})
