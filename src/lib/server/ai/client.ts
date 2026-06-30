import Groq from 'groq-sdk';
import type { z } from 'zod';
import { env } from '$env/dynamic/private';

const GROQ_TIMEOUT_MS = 30_000;

function requireEnv(name: string): string {
	const value = env[name];
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

let client: Groq | null = null;

function getClient(): Groq {
	if (!client) {
		client = new Groq({ apiKey: requireEnv('GROQ_API_KEY'), timeout: GROQ_TIMEOUT_MS });
	}
	return client;
}

function getModel(): string {
	return env.GROQ_MODEL ?? 'llama-3.3-70b-versatile';
}

export class PipelineStageError extends Error {
	constructor(
		message: string,
		public readonly stage: 'stage1' | 'stage2' | 'stage3',
		public readonly cause?: unknown
	) {
		super(message);
		this.name = 'PipelineStageError';
	}
}

/**
 * Calls Groq with JSON-object mode, parses the response as JSON, and validates it against
 * the given Zod schema. Any failure (timeout, malformed JSON, schema mismatch) is normalized
 * into a PipelineStageError rather than thrown raw, so callers can handle pipeline failures
 * uniformly instead of crashing the request.
 */
export async function callGroqForJson<Schema extends z.ZodTypeAny>(args: {
	stage: 'stage1' | 'stage2' | 'stage3';
	systemPrompt: string;
	userPrompt: string;
	schema: Schema;
}): Promise<z.infer<Schema>> {
	const { stage, systemPrompt, userPrompt, schema } = args;

	let rawContent: string | null;
	try {
		const completion = await getClient().chat.completions.create({
			model: getModel(),
			messages: [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: userPrompt }
			],
			response_format: { type: 'json_object' },
			temperature: 0.3
		});
		rawContent = completion.choices[0]?.message?.content ?? null;
	} catch (err) {
		throw new PipelineStageError(`Groq request failed or timed out (${stage})`, stage, err);
	}

	if (!rawContent) {
		throw new PipelineStageError(`Groq returned an empty response (${stage})`, stage);
	}

	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(rawContent);
	} catch (err) {
		console.error(`[${stage}] failed to parse Groq response as JSON:`, rawContent);
		throw new PipelineStageError(`Groq returned malformed JSON (${stage})`, stage, err);
	}

	const result = schema.safeParse(parsedJson);
	if (!result.success) {
		console.error(`[${stage}] Groq response failed schema validation:`, rawContent, result.error);
		throw new PipelineStageError(`Groq response did not match expected schema (${stage})`, stage, result.error);
	}

	return result.data;
}
