export * as DescribeImageTool from "./describe-image.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { ToolFailure, LLM, Media, Message, LLMClient } from "@opencode/ai"
import { Effect, Schema } from "effect"
import { readFile } from "fs/promises"
import { Config } from "../../config.js"
import { Model } from "../../model.js"
import { ModelResolver } from "../../model-resolver.js"
import { SessionMediaStore } from "../../session/media-store.js"

export const name = "describe_image"

export const Plugin = {
  id: "opencode.tool.describe_image",
  effect: Effect.fn("DescribeImageTool.Plugin")(function* (ctx: Context) {
    const config = yield* Config.Service
    const models = yield* Model.Service
    const resolver = yield* ModelResolver.Service
    const llm = yield* LLMClient.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { namespace: "opencode", codemode: false },
          description:
            "Inspect an image that was attached to the conversation and stored in the project cache (because the current model cannot read images directly). Provide the stored handle and a specific question, and this tool asks a vision-capable model about the image and returns a textual answer.",
          input: Schema.Struct({
            handle: Schema.String.annotate({
              description: "The stored image handle (e.g. the token shown in the attachment reference message).",
            }),
            question: Schema.String.annotate({
              description: "The specific question to ask about the image, e.g. 'what does line 3 say?'",
            }),
          }),
          output: Schema.String,
          execute: (input, context) =>
            Effect.gen(function* () {
              const selection = Config.latest(yield* config.entries(), "image_model")
              if (!selection)
                return yield* new ToolFailure({
                  message: 'No "image_model" is configured. Set it to a vision-capable model to describe images.',
                })

              const info = (yield* models.available()).find(
                (m) => m.providerID === selection.providerID && m.id === selection.model,
              )
              if (!info)
                return yield* new ToolFailure({
                  message: `Configured image_model "${selection.providerID}/${selection.model}" is not available.`,
                })

              const resolved = yield* resolver
                .resolveModel(info, selection.variant)
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Failed to resolve image_model: ${error.message}` }),
                  ),
                )
              const path = yield* Effect.promise(() =>
                SessionMediaStore.resolveFile(ctx.location.directory, input.handle),
              )
              if (path === undefined)
                return yield* new ToolFailure({
                  message: `Unable to find stored image "${input.handle}".`,
                })
              const bytes = yield* Effect.tryPromise({
                try: () => readFile(path),
                catch: (cause) =>
                  new ToolFailure({
                    message: `Unable to read stored image "${input.handle}": ${cause instanceof Error ? cause.message : cause}`,
                  }),
              })

              const request = LLM.request({
                model: resolved.model,
                system: [
                  "You are inspecting an image on behalf of a text-only model.",
                  "Answer the user's specific question about the image accurately and concisely.",
                  "If the image does not contain the information requested, say so plainly.",
                ].join("\n"),
                messages: [
                  Message.user([
                    Message.text(input.question),
                    Message.media(Media.bytes(new Uint8Array(bytes), detectMime(path))),
                  ]),
                ],
              })
              const response = yield* llm.generate(request).pipe(
                Effect.mapError(
                  (error) => new ToolFailure({ message: `Failed to describe image: ${error.message}` }),
                ),
              )
              return { output: response.text, content: [] }
            }),
        }),
      )
      .pipe(Effect.orDie)
  }),
}

function detectMime(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith(".png")) return "image/png"
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg"
  if (lower.endsWith(".gif")) return "image/gif"
  if (lower.endsWith(".webp")) return "image/webp"
  if (lower.endsWith(".svg")) return "image/svg+xml"
  return "application/octet-stream"
}
