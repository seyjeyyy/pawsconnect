type Configuration = { url?: string; serviceKey?: string; cronSecret?: string };
export async function handleMaintenance(request: Request, config: Configuration, fetcher: typeof fetch = fetch): Promise<Response> {
  const json = (status: number, body: unknown) => Response.json(body, { status });
  if (request.method !== 'POST') return json(405, { error: 'POST required' });
  if (!config.url || !config.serviceKey || !config.cronSecret || config.cronSecret.length < 32) return json(503, { error: 'Maintenance credentials are not configured' });
  const supplied = request.headers.get('authorization')?.replace(/^Bearer /, '') || '';
  // Hash before comparing so neither the comparison time nor response reveals the secret.
  const digest = async (text: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  const [a,b] = await Promise.all([digest(supplied),digest(config.cronSecret)]);
  let difference = 0; for(let i=0;i<a.length;i++) difference |= a[i]^b[i];
  if (difference !== 0) return json(401, { error: 'Unauthorized' });
  try {
    const result: Record<string,number> = {};
    for(const name of ['expire_order_reservations','expire_pet_reservations']) {
      const response = await fetcher(`${config.url}/rest/v1/rpc/${name}`, { method:'POST', headers: { apikey:config.serviceKey, Authorization:`Bearer ${config.serviceKey}`, 'Content-Type':'application/json' }, body:'{}', signal:AbortSignal.timeout(15000) });
      if(!response.ok) return json(503,{error:'Reservation maintenance could not complete. Retry safely.'});
      const count = await response.json();
      if(!Number.isInteger(count) || count < 0) return json(502,{error:'Unexpected database response'});
      result[name]=count;
    }
    return json(200,{data:result});
  } catch { return json(503,{error:'Database connection unavailable. Retry safely.'}); }
}
