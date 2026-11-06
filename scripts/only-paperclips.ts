export {};
const base = (process.env.ORG_URL ?? 'http://127.0.0.1:4780').replace(/\/$/, '');
const response = await fetch(base + '/api/examples/only-paperclips', { method: 'POST' });
const result = await response.json() as { error?: string; org?: { id: string } };
if (!response.ok || !result.org) throw new Error(result.error ?? 'Could not establish the example.');
console.log('Only Paperclips is ready in simulation. Open the calendar and business registers, then press Start.');
console.log(base + '/#/org/' + result.org.id);

