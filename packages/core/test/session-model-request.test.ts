import { describe, expect, test } from "bun:test"
import { readFile, readdir } from "fs/promises"
import { join } from "path"
import { Effect } from "effect"
import { Message, ToolResultPart, Media } from "@opencode/ai"
import { boundImages, offloadImages, unsupportedParts } from "@opencode/core/session/model-request"
import { withTempDir } from "./fixture/tmpdir.js"

const CACHE_DIR = ".opencode/cache/media"

const capabilities = (input: string[]) => ({ tools: true, input, output: ["text"] })

describe("SessionModelRequest.offloadImages", () => {
  const mediaPart = (name: string) => ({
    type: "media" as const,
    media: Media.base64("aGVsbG8=", "image/png"),
    filename: name,
  })

  const readCache = (path: string) =>
    Effect.promise(() => readdir(join(path, CACHE_DIR)).catch(() => [] as string[]))

  const referenceText = (part: unknown): string => {
    if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part)
      return String(part.text)
    return ""
  }

  test("offloads user media images to the cache when the model cannot read images", () =>
    withTempDir(({ path }) =>
      Effect.gen(function* () {
        const messages = [Message.user([Message.text("Look at this"), mediaPart("logo.png")])]
        const result = yield* offloadImages(messages, capabilities(["text"]), path)

        expect(result[0]?.content[0]).toEqual(Message.text("Look at this"))
        const reference = referenceText(result[0]?.content[1])
        expect(reference).toContain("Attached image stored as")
        expect(reference).toContain("Title: logo.png")
        // The bytes are persisted under the content-addressed handle.
        const files = yield* readCache(path)
        expect(files).toHaveLength(1)
        expect(files[0]).toEndWith(".png")
        const bytes = yield* Effect.promise(() => readFile(join(path, CACHE_DIR, files[0]!), "base64"))
        expect(bytes).toBe("aGVsbG8=")
      }),
    ).pipe(Effect.runPromise),
  )

  test("offloads images nested in tool results", () =>
    withTempDir(({ path }) =>
      Effect.gen(function* () {
        const messages = [
          Message.tool(
            ToolResultPart.make({
              id: "call_1",
              name: "take_screenshot",
              result: {
                type: "content",
                value: [
                  { type: "text", text: "Screenshot taken" },
                  {
                    type: "file",
                    uri: "data:image/png;base64,aGVsbG8=",
                    mime: "image/png",
                    name: "screenshot.png",
                  },
                ],
              },
            }),
          ),
        ]
        const result = yield* offloadImages(messages, capabilities(["text"]), path)

        const value = result[0]?.content[0]
        expect(value).toMatchObject({ type: "tool-result" })
        expect(value.type).toBe("tool-result")
        if (value.type !== "tool-result" || value.result.type !== "content") throw new Error("unexpected shape")
        expect(value.result.value).toHaveLength(2)
        expect(value.result.value[0]).toEqual({ type: "text", text: "Screenshot taken" })
        const reference = referenceText(value.result.value[1])
        expect(reference).toContain("Attached image stored as")
        expect(reference).toContain("Title: screenshot.png")
        const files = yield* readCache(path)
        expect(files).toHaveLength(1)
        const bytes = yield* Effect.promise(() => readFile(join(path, CACHE_DIR, files[0]!), "base64"))
        expect(bytes).toBe("aGVsbG8=")
      }),
    ).pipe(Effect.runPromise),
  )

  test("leaves non-image files and supported-model messages untouched", () =>
    withTempDir(({ path }) =>
      Effect.gen(function* () {
        const pdf = Message.tool(
          ToolResultPart.make({
            id: "call_1",
            name: "read",
            result: {
              type: "content",
              value: [{ type: "file", uri: "data:application/pdf;base64,JVBERg==", mime: "application/pdf", name: "d.pdf" }],
            },
          }),
        )
        // text-only model: pdf and image both unsupported in general, but offload only handles images
        const result = yield* offloadImages([pdf], capabilities(["text"]), path)

        // pdf is not an image, so the whole message is returned unchanged (same reference)
        expect(result[0]).toBe(pdf)
        const stored = yield* readCache(path)
        expect(stored).toHaveLength(0)

        // a model that supports images skips offloading entirely
        const withImage = [Message.user(mediaPart("logo.png"))]
        const supported = yield* offloadImages(withImage, capabilities(["text", "image"]), path)
        expect(supported[0]?.content[0]).toMatchObject({ type: "media" })
      }),
    ).pipe(Effect.runPromise),
  )
})

describe("SessionModelRequest.unsupportedParts", () => {
  test("replaces unsupported user media with a visible error", () => {
    const messages = unsupportedParts(
      [
        Message.user([
          Message.text("Describe these files"),
          { type: "media", media: Media.base64("aGVsbG8=", "image/png"), filename: "logo.png" },
          { type: "media", media: Media.base64("JVBERg==", "application/pdf"), filename: "document.pdf" },
        ]),
      ],
      capabilities(["text"]),
    )

    expect(messages[0]?.content).toEqual([
      Message.text("Describe these files"),
      Message.text('ERROR: Cannot read "logo.png" (this model does not support image input). Inform the user.'),
      Message.text('ERROR: Cannot read "document.pdf" (this model does not support pdf input). Inform the user.'),
    ])
  })

  test("replaces unsupported media nested in tool results", () => {
    const messages = unsupportedParts(
      [
        Message.tool(
          ToolResultPart.make({
            id: "call_1",
            name: "read",
            result: {
              type: "content",
              value: [
                { type: "text", text: "Image read successfully" },
                { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "logo.png" },
              ],
            },
          }),
        ),
      ],
      capabilities(["text"]),
    )

    expect(messages[0]?.content[0]).toMatchObject({
      type: "tool-result",
      result: {
        type: "content",
        value: [
          { type: "text", text: "Image read successfully" },
          {
            type: "text",
            text: 'ERROR: Cannot read "logo.png" (this model does not support image input). Inform the user.',
          },
        ],
      },
    })
  })

  test("replaces images xAI cannot decode and keeps png, jpeg and webp", () => {
    const image = (mime: string, name: string) => ({
      type: "media" as const,
      media: Media.base64("aGVsbG8=", mime),
      filename: name,
    })
    const user = [image("image/png", "a.png"), image("image/jpeg", "b.jpg"), image("image/webp", "c.webp")]
    const messages = [
      Message.user([...user, image("image/gif", "d.gif")]),
      Message.tool(
        ToolResultPart.make({
          id: "call_1",
          name: "read",
          result: {
            type: "content",
            value: [
              { type: "text", text: "Image read successfully" },
              { type: "file", uri: "data:image/gif;base64,R0lGODlh", mime: "image/gif", name: "e.gif" },
            ],
          },
        }),
      ),
    ]
    const result = unsupportedParts(messages, capabilities(["text", "image"]), "xai")

    expect(result[0]?.content).toEqual([
      ...user,
      Message.text('ERROR: Cannot read "d.gif" (this model does not support image/gif input). Inform the user.'),
    ])
    expect(result[1]?.content[0]).toMatchObject({
      type: "tool-result",
      result: {
        type: "content",
        value: [
          { type: "text", text: "Image read successfully" },
          {
            type: "text",
            text: 'ERROR: Cannot read "e.gif" (this model does not support image/gif input). Inform the user.',
          },
        ],
      },
    })
    expect(unsupportedParts(messages, capabilities(["text", "image"]), "openai")).toEqual(messages)
  })

  test("preserves supported media", () => {
    const message = Message.user({ type: "media", media: Media.base64("aGVsbG8=", "image/png") })
    expect(unsupportedParts([message], capabilities(["text", "image"]))[0]?.content).toEqual(message.content)
  })

  test("returns the same messages when nothing is unsupported", () => {
    const messages = [
      Message.user([Message.text("hi"), { type: "media", media: Media.base64("aGVsbG8=", "image/png") }]),
      Message.assistant("hello"),
      Message.tool(
        ToolResultPart.make({
          id: "call_1",
          name: "read",
          result: {
            type: "content",
            value: [{ type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "logo.png" }],
          },
        }),
      ),
    ]
    const result = unsupportedParts(messages, capabilities(["text", "image"]))
    expect(result).toHaveLength(messages.length)
    result.forEach((message, index) => expect(message).toBe(messages[index]))
  })

  test("rebuilds only messages with unsupported media", () => {
    const text = Message.user("plain")
    const supported = Message.tool(
      ToolResultPart.make({
        id: "call_1",
        name: "read",
        result: { type: "content", value: [{ type: "text", text: "no files" }] },
      }),
    )
    const tool = ToolResultPart.make({
      id: "call_2",
      name: "read",
      result: {
        type: "content",
        value: [
          { type: "text", text: "Read" },
          { type: "file", uri: "data:application/pdf;base64,JVBERg==", mime: "application/pdf" },
        ],
      },
    })
    const unsupported = Message.make({ role: "tool", content: [tool, Message.text("caption")] })
    const result = unsupportedParts([text, supported, unsupported], capabilities(["text"]))

    expect(result[0]).toBe(text)
    expect(result[1]).toBe(supported)
    expect(result[2]).not.toBe(unsupported)
    expect(result[2]).toBeInstanceOf(Message)
    expect(result[2]?.content[1]).toEqual(Message.text("caption"))
    expect(result[2]?.content[0]).toMatchObject({
      type: "tool-result",
      result: {
        type: "content",
        value: [
          { type: "text", text: "Read" },
          { type: "text", text: "ERROR: Cannot read pdf (this model does not support pdf input). Inform the user." },
        ],
      },
    })
    expect(tool.result).toMatchObject({
      type: "content",
      value: [
        { type: "text", text: "Read" },
        { type: "file", mime: "application/pdf" },
      ],
    })
  })
})

describe("SessionModelRequest.boundImages", () => {
  test("preserves images below the trigger", () => {
    const messages = [Message.user({ type: "media", media: Media.base64("aGVsbG8=", "image/png") })]
    expect(boundImages(messages)).toBe(messages)
  })

  test("replaces oldest images until the retained payload reaches the target", () => {
    const image = "a".repeat(9 * 1024 * 1024)
    const text = Message.user("plain")
    const third = Message.user({ type: "media", media: Media.base64(image, "image/png"), filename: "third.png" })
    const messages = [
      Message.user({ type: "media", media: Media.base64(image, "image/png"), filename: "first.png" }),
      text,
      Message.user({ type: "media", media: Media.base64(image, "image/png"), filename: "second.png" }),
      third,
    ]
    const result = boundImages(messages)

    expect(result[0]).toBeInstanceOf(Message)
    expect(result[0]?.content).toEqual([Message.text(expect.stringContaining("image was removed"))])
    expect(result[1]).toBe(text)
    expect(result[2]).not.toBe(messages[2])
    expect(result[2]?.content[0]).toMatchObject({ type: "text" })
    expect(result[3]).toBe(third)
  })

  test("keeps the replaced prefix stable as new images arrive, so the prompt cache survives", () => {
    const image = (name: string) =>
      Message.user({ type: "media", media: Media.base64("a".repeat(3 * 1024 * 1024), "image/png"), filename: name })
    const removed = (messages: ReturnType<typeof boundImages>) =>
      messages.filter((message) => message.content[0]?.type === "text").length
    const history = Array.from({ length: 9 }, (_, i) => image(`${i}.png`))

    // 27 MiB passes the 25 MiB trigger: the oldest four go, leaving 15 MiB.
    expect(removed(boundImages(history))).toBe(4)
    // Each later image used to move the cut by one; now the cut holds until the kept payload passes the trigger again.
    expect(removed(boundImages([...history, image("9.png")]))).toBe(4)
    expect(removed(boundImages([...history, image("9.png"), image("10.png"), image("11.png")]))).toBe(4)
    expect(removed(boundImages([...history, ...Array.from({ length: 4 }, (_, i) => image(`${9 + i}.png`))]))).toBe(8)
  })

  test("replaces images nested in tool results", () => {
    const image = "a".repeat(13 * 1024 * 1024)
    const result = boundImages([
      Message.tool(
        ToolResultPart.make({
          id: "call_1",
          name: "read",
          result: {
            type: "content",
            value: [
              { type: "file", uri: `data:image/png;base64,${image}`, mime: "image/png", name: "first.png" },
              { type: "file", uri: `data:image/png;base64,${image}`, mime: "image/png", name: "second.png" },
            ],
          },
        }),
      ),
    ])

    expect(result[0]?.content[0]).toMatchObject({
      type: "tool-result",
      result: {
        type: "content",
        value: [{ type: "text" }, { type: "file", name: "second.png" }],
      },
    })
  })
})
