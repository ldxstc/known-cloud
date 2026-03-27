import OpenAI from "openai";

import type { EnvBindings } from "./db";

export const EXTRACTION_MODEL = "gpt-4o-mini";
export const SYNTHESIS_MODEL = "gpt-4o-mini";

type JsonCompletionOptions = {
  model?: string;
  systemPrompt: string;
  prompt: string;
  temperature?: number;
};

export function getOpenAI(env: EnvBindings) {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required.");
  }

  return new OpenAI({ apiKey: env.OPENAI_API_KEY });
}

export async function createJsonCompletion(
  env: EnvBindings,
  { model = EXTRACTION_MODEL, systemPrompt, prompt, temperature = 0.1 }: JsonCompletionOptions,
) {
  const openai = getOpenAI(env);
  const response = await openai.chat.completions.create({
    model,
    temperature,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ],
  });

  return {
    content: response.choices[0]?.message?.content ?? "",
    usage: response.usage,
  };
}
