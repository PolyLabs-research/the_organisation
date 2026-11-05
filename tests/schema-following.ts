import type { FakeOpenAI, FakeReply, FakeResponse } from './fake-openai-api';

// A stand-in that plays a model's part well enough for an organisation to
// run on it: asked for a structured answer, it returns the plainest object
// that fits the schema it was given; given tools, it writes one file and
// then reports. It has no opinions, so every review passes and nothing is
// objected to. What it exercises is everything between the engine and the
// wire: which provider a call goes to, what is sent, how the reply is read,
// and how the spend is counted.

type Schema = Record<string, any>;

/** The plainest value that fits a JSON schema: the first of an enum, one item in a list, a word for a string. */
export function fill(schema: Schema, root: Schema = schema): unknown {
  if (schema.$ref) return fill(resolve(schema.$ref, root), root);
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  const variants = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(variants)) return fill(variants.find((v: Schema) => v.type !== 'null') ?? variants[0], root);
  const type = Array.isArray(schema.type) ? schema.type.find((t: string) => t !== 'null') : schema.type;
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries((schema.properties ?? {}) as Record<string, Schema>)) out[key] = fill(value, root);
      return out;
    }
    case 'array': {
      const count = Math.max(1, Number(schema.minItems ?? 0));
      return Array.from({ length: Math.min(count, schema.maxItems ?? count) }, () => fill(schema.items ?? {}, root));
    }
    case 'integer':
    case 'number':
      return Math.max(1, Number(schema.minimum ?? schema.exclusiveMinimum ?? 1));
    case 'boolean':
      return false;
    case 'null':
      return null;
    default:
      return 'Settled.';
  }
}

function resolve(ref: string, root: Schema): Schema {
  return ref
    .replace(/^#\//, '')
    .split('/')
    .reduce((node, key) => node?.[key], root);
}

/** The schema a request wants its answer to fit: handed over as such, or written into the prompt. */
function schemaIn(format: Schema | undefined, prompt: string): Schema | null {
  if (format?.json_schema?.schema) return format.json_schema.schema;
  if (format?.schema) return format.schema;
  const at = prompt.lastIndexOf('must match this JSON Schema:\n');
  return at < 0 ? null : JSON.parse(prompt.slice(at + 'must match this JSON Schema:\n'.length));
}

/** Have a stand-in endpoint answer every request for itself, on both of the APIs it speaks. */
export function followSchemas(api: FakeOpenAI): { files: string[] } {
  const files: string[] = [];
  const nextFile = (text: string) => {
    // Agents are told which folder their team keeps its files in.
    const dir = /Keep your files under `([^`]+)\/`/.exec(text)?.[1] ?? 'shared';
    const file = `${dir}/note-${files.length + 1}.md`;
    files.push(file);
    return { path: file, content: `# Note ${files.length}\n\nWritten over the wire.` };
  };

  api.auto.chat = (body): FakeReply => {
    const usage = { prompt_tokens: 2000, completion_tokens: 500 };
    if (body.tools?.length) {
      const answered = body.messages.some((m: any) => m.role === 'tool');
      if (answered) return { content: 'Wrote the note and checked it.', usage };
      return { reasoning: 'I will write the note.', calls: [{ name: 'write_file', arguments: nextFile(String(body.messages[0].content)) }], usage };
    }
    const schema = schemaIn(body.response_format, String(body.messages.at(-1).content));
    return { reasoning: 'Considering.', content: schema ? JSON.stringify(fill(schema)) : 'Done.', usage };
  };

  api.auto.responses = (body): FakeResponse => {
    const usage = { input_tokens: 2000, output_tokens: 500 };
    if (body.tools?.length) {
      const answered = body.input.some((i: any) => i.type === 'function_call_output');
      if (answered) return { text: 'Wrote the note and checked it.', usage };
      return { reasoning: 'I will write the note.', calls: [{ name: 'write_file', arguments: nextFile(String(body.instructions)) }], usage };
    }
    const prompt = String(body.input.find((i: any) => i.role === 'user')?.content ?? '');
    const schema = schemaIn(body.text?.format, prompt);
    return { reasoning: 'Considering.', text: schema ? JSON.stringify(fill(schema)) : 'Done.', usage };
  };
  return { files };
}
