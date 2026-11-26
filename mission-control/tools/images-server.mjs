// Picture making (read-only: it changes nothing outside your PC): sends a prompt to ComfyUI
// running on Windows with your graphics card, waits for the picture and returns it. The
// harness saves the picture as a file on the card. ComfyUI listens on 127.0.0.1:8188 only;
// containers reach it through Docker Desktop's host.docker.internal.
//
// Settings (tools.json env): COMFY_URL, IMAGE_MODEL, IMAGE_TEXT_ENCODER, IMAGE_VAE.
// The default workflow is Z-Image Turbo (8 steps, no negative prompt).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const COMFY = (process.env.COMFY_URL || "http://host.docker.internal:8188").replace(/\/+$/, "");
const MODEL = process.env.IMAGE_MODEL || "z_image_turbo_bf16.safetensors";
const TEXT_ENCODER = process.env.IMAGE_TEXT_ENCODER || "qwen_3_4b.safetensors";
const VAE = process.env.IMAGE_VAE || "ae.safetensors";
const WAIT_MS = Number(process.env.IMAGE_WAIT_MS) || 540_000;

const SIZES = {
  square: [1024, 1024],
  landscape: [1216, 832],
  portrait: [832, 1216],
  // 2:3, the shape of a 6 × 9 in book cover (Mission Control scales the chosen one to 300 dpi)
  cover: [896, 1344],
  wide: [1344, 768],
  small: [768, 768],
};

const NOT_RUNNING =
  'The picture maker (ComfyUI) isn\'t running on the PC. It starts by itself at login; to start it now, run in PowerShell: Start-ScheduledTask "Mission Control ComfyUI" (see README-HQ.md, Pictures), then try again in a minute.';

/** The ComfyUI workflow for one picture. Exported for tests. */
export function workflow({ prompt, size = "square", seed }) {
  const [width, height] = SIZES[size] ?? SIZES.square;
  return {
    1: { class_type: "UNETLoader", inputs: { unet_name: MODEL, weight_dtype: "default" } },
    2: { class_type: "CLIPLoader", inputs: { clip_name: TEXT_ENCODER, type: "lumina2", device: "default" } },
    3: { class_type: "VAELoader", inputs: { vae_name: VAE } },
    4: { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 3 } },
    5: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: prompt } },
    6: { class_type: "ConditioningZeroOut", inputs: { conditioning: ["5", 0] } },
    7: { class_type: "EmptySD3LatentImage", inputs: { width, height, batch_size: 1 } },
    8: {
      class_type: "KSampler",
      inputs: { model: ["4", 0], positive: ["5", 0], negative: ["6", 0], latent_image: ["7", 0], seed, steps: 8, cfg: 1, sampler_name: "res_multistep", scheduler: "simple", denoise: 1 },
    },
    9: { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    10: { class_type: "SaveImage", inputs: { images: ["9", 0], filename_prefix: "mission-control" } },
  };
}

/** ComfyUI's error for a failed run, in one line. Exported for tests. */
export function runError(entry) {
  for (const [kind, m] of entry?.status?.messages ?? []) {
    if (kind === "execution_error") return `${m.node_type ?? "a step"} failed: ${String(m.exception_message ?? "").trim().split("\n")[0]}`;
  }
  return `ComfyUI said ${entry?.status?.status_str ?? "it failed"}`;
}

async function comfy(path, init = {}, ms = 15000) {
  return fetch(`${COMFY}${path}`, { ...init, signal: AbortSignal.timeout(ms) });
}

const fail = (text) => ({ content: [{ type: "text", text }], isError: true });

async function generate({ prompt, size = "square", seed }) {
  const started = Date.now();
  const useSeed = Number.isInteger(seed) ? seed : Math.floor(Math.random() * 2 ** 31);
  let id;
  try {
    const r = await comfy("/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: workflow({ prompt, size, seed: useSeed }) }) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const why = body?.error?.message ?? body?.error ?? r.status;
      const nodes = Object.values(body?.node_errors ?? {}).flatMap((n) => (n.errors ?? []).map((e) => `${e.message}: ${e.details ?? ""}`));
      return fail(`ComfyUI refused the picture (${why})${nodes.length ? `: ${nodes.slice(0, 2).join("; ")}` : ""}. Are the model files in place?`);
    }
    id = body.prompt_id;
  } catch {
    return fail(NOT_RUNNING);
  }

  // Wait for it (about 1.5 minutes on the RX 9060 XT; longer the first time while models load)
  let entry;
  while (Date.now() - started < WAIT_MS) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const h = await (await comfy(`/history/${id}`)).json();
      if (h[id]?.status?.completed || ["success", "error"].includes(h[id]?.status?.status_str)) {
        entry = h[id];
        break;
      }
    } catch {
      return fail("ComfyUI stopped while making the picture (it may have crashed: see its log in %LOCALAPPDATA%\\Comfy-Desktop\\hq-logs).");
    }
  }
  if (!entry) {
    await comfy("/interrupt", { method: "POST" }).catch(() => {});
    return fail(`The picture took longer than ${Math.round(WAIT_MS / 60000)} minutes, so it was stopped.`);
  }
  if (entry.status?.status_str !== "success") return fail(runError(entry));

  const img = Object.values(entry.outputs ?? {}).flatMap((o) => o.images ?? [])[0];
  if (!img) return fail("ComfyUI finished but made no picture.");
  const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder ?? "", type: img.type ?? "output" });
  const file = await comfy(`/view?${q}`, {}, 30000);
  if (!file.ok) return fail(`Couldn't fetch the finished picture (${file.status}).`);
  const data = Buffer.from(await file.arrayBuffer()).toString("base64");
  const [w, h] = SIZES[size] ?? SIZES.square;
  const secs = Math.round((Date.now() - started) / 1000);
  return {
    content: [
      { type: "text", text: `Made a ${w}×${h} picture in ${secs} s (seed ${useSeed}). It's attached to the card.` },
      { type: "image", data, mimeType: "image/png" },
    ],
  };
}

const server = new McpServer({ name: "images", version: "1.0.0" });

server.registerTool(
  "generate_image",
  {
    description:
      "Make a new picture from a text description with the local image model (on this PC's graphics card; about 1.5 minutes). " +
      "Write the prompt in English as a detailed visual description: subject, setting, lighting, style (photo, illustration, painting…). " +
      "The picture is attached to the card automatically.",
    inputSchema: {
      prompt: z.string().min(3).max(1500).describe("Detailed description of the picture"),
      size: z.enum(["square", "landscape", "portrait", "cover", "wide", "small"]).optional().describe("Shape: square 1024×1024 (default), landscape, portrait, cover (2:3 book cover, 896×1344), wide, or small (faster)"),
      seed: z.number().int().min(0).max(2 ** 31).optional().describe("Same seed and prompt give the same picture"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async (args) => generate(args),
);

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  await server.connect(new StdioServerTransport());
}
