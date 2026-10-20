import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';

const options = Object.fromEntries(process.argv.slice(2).map(argument => {
  const separator = argument.indexOf('=');
  if (separator < 0) throw new Error(`Expected --name=value: ${argument}`);
  return [argument.slice(2, separator), argument.slice(separator + 1)];
}));
const repetitions = Number(options.repeats ?? 5);
const warmups = Number(options.warmups ?? 2);
const contexts = (options.contexts ?? '512,4096,16384,32768,60000').split(',').map(Number);
const outputTokens = Number(options.tokens ?? 256);
const outputPath = options.output ?? 'benchmark-results/llama.json';
const namespace = options.namespace ?? 'vllm';
const model = options.model ?? 'qwen3.6-35b-a3b';
for (const [name, value] of Object.entries({ repetitions, outputTokens })) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
}
if (!Number.isInteger(warmups) || warmups < 0) throw new Error('Invalid warmups');
if (contexts.some(value => !Number.isInteger(value) || value < 64 || value + outputTokens + 128 > 65536)) {
  throw new Error('Contexts must leave room for output and chat-template overhead within 65536 tokens');
}

function request(path, body, onEvent) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const command = spawn('kubectl', [
      'exec', '-i', '-n', namespace, 'deployment/llama-server', '-c', 'llama-server', '--',
      'curl', '--fail-with-body', '--silent', '--show-error', '--no-buffer',
      '--connect-timeout', '10', '--max-time', options.timeout ?? '600',
      `http://127.0.0.1:8080${path}`, '-H', 'Content-Type: application/json', '--data-binary', '@-',
    ]);
    let stdout = '';
    let pending = '';
    let stderr = '';
    let parseError;
    let done = false;
    command.stdout.setEncoding('utf8');
    command.stdout.on('data', chunk => {
      stdout += chunk;
      if (!onEvent) return;
      pending += chunk.replaceAll('\r\n', '\n');
      let separator;
      while ((separator = pending.indexOf('\n\n')) >= 0) {
        const event = pending.slice(0, separator);
        pending = pending.slice(separator + 2);
        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') { done = true; continue; }
          try { onEvent(JSON.parse(data), performance.now() - started); }
          catch (error) { parseError = error; }
        }
      }
    });
    command.stderr.on('data', chunk => { stderr += chunk; });
    command.on('error', reject);
    command.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    command.on('close', code => {
      if (code !== 0) return reject(new Error(`Request failed (${code}): ${stderr} ${stdout.slice(-600)}`));
      if (parseError) return reject(parseError);
      if (onEvent && !done) return reject(new Error('Stream ended without [DONE]'));
      try { resolve(onEvent ? null : JSON.parse(stdout)); }
      catch (error) { reject(error); }
    });
    command.stdin.end(JSON.stringify(body));
  });
}

async function makePrompt(target) {
  const unit = 'Record: the inventory service accepted the request, checked the item count, and returned a successful response.\n';
  const sample = await request('/tokenize', { content: unit.repeat(100) });
  const repeats = Math.ceil(target / (sample.tokens.length / 100)) + 20;
  const encoded = await request('/tokenize', { content: unit.repeat(repeats) });
  const decoded = await request('/detokenize', { tokens: encoded.tokens.slice(0, target - 48) });
  return decoded.content;
}

async function measure(label, prompt, thinking = false, maxTokens = outputTokens) {
  const result = { label, thinking, requested_output_tokens: maxTokens };
  const started = performance.now();
  try {
    await request('/v1/chat/completions', {
      model,
      messages: [{ role: 'user', content: `${randomUUID()}\n${prompt}\nWrite a detailed numbered technical analysis of this inventory-service log.` }],
      stream: true,
      stream_options: { include_usage: true },
      chat_template_kwargs: { enable_thinking: thinking },
      temperature: 0,
      max_tokens: maxTokens,
      ignore_eos: true,
      cache_prompt: false,
    }, (event, elapsed) => {
      if (event.error) throw new Error(JSON.stringify(event.error));
      const choice = event.choices?.[0];
      const delta = choice?.delta;
      if (delta?.content || delta?.reasoning_content) result.first_output_ms ??= elapsed;
      if (delta?.content) result.first_content_ms ??= elapsed;
      if (choice?.finish_reason) result.finish_reason = choice.finish_reason;
      if (event.usage) result.usage = event.usage;
      if (event.timings) result.timings = event.timings;
    });
    result.total_ms = performance.now() - started;
    result.ok = Boolean(result.first_output_ms && result.usage?.completion_tokens);
    if (!result.ok) result.error = 'Missing output or final token usage';
  } catch (error) {
    result.ok = false;
    result.error = error.message;
    result.total_ms = performance.now() - started;
  }
  console.log(JSON.stringify({ label, ok: result.ok, ttft_ms: result.first_output_ms,
    total_ms: result.total_ms, tokens: result.usage?.completion_tokens,
    decode_tps: result.timings?.predicted_per_second, cached: result.timings?.cache_n, error: result.error }));
  return result;
}

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null;
}

const report = {
  started_at: new Date().toISOString(), model,
  transport: 'kubectl exec -> curl -> llama localhost; client latency includes exec overhead',
  methodology: 'Unique leading nonce, cache_prompt=false, fixed output via ignore_eos; synthetic repeated log input; not a quality benchmark',
  options: { contexts, repetitions, warmups, outputTokens }, results: [], summaries: [],
};
await mkdir(dirname(outputPath), { recursive: true });
async function save() { await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`); }

for (const target of contexts) {
  const prompt = await makePrompt(target);
  for (let index = 0; index < warmups; index++) {
    const warmup = await measure(`warmup-${target}-${index + 1}`, prompt);
    if (!warmup.ok) throw new Error(`Warmup failed; stopped before increasing load: ${warmup.error}`);
  }
  const group = [];
  for (let index = 0; index < repetitions; index++) {
    const result = await measure(`context-${target}`, prompt);
    report.results.push(result);
    group.push(result);
    await save();
    if (!result.ok) throw new Error(`Benchmark failed; partial results saved to ${outputPath}`);
  }
  report.summaries.push({
    target_input_tokens: target, runs: group.length,
    actual_prompt_tokens: group.map(result => result.usage.prompt_tokens),
    median_ttft_ms: percentile(group.map(result => result.first_output_ms), 0.5),
    p95_ttft_ms: percentile(group.map(result => result.first_output_ms), 0.95),
    median_total_ms: percentile(group.map(result => result.total_ms), 0.5),
    median_decode_tps: percentile(group.map(result => result.timings?.predicted_per_second), 0.5),
    median_prefill_tps: percentile(group.map(result => result.timings?.prompt_per_second), 0.5),
  });
  await save();
}
if (options.thinking === 'true') {
  report.results.push(await measure('thinking-4096', await makePrompt(4096), true, 1024));
  await save();
}
if (options.queue === 'true') {
  const prompt = await makePrompt(512);
  report.results.push(...await Promise.all([
    measure('queue-request-1', prompt), measure('queue-request-2', prompt),
  ]));
  await save();
}
console.log(JSON.stringify({ output: outputPath, summaries: report.summaries }, null, 2));
if (report.results.some(result => !result.ok)) process.exitCode = 1;