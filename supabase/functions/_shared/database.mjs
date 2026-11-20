function serviceKey(env) {
  if (env.SUPABASE_SECRET_KEYS) {
    const parsed = JSON.parse(env.SUPABASE_SECRET_KEYS);
    if (parsed.default) return parsed.default;
  }
  return env.SUPABASE_SERVICE_ROLE_KEY;
}

export function databaseRpc(env, fetcher = fetch) {
  const dbKey = serviceKey(env);
  if (!env.SUPABASE_URL || !dbKey) throw new Error("Missing database configuration.");
  const dbBase = env.SUPABASE_URL.replace(/\/$/, "");
  const dbHeaders = { apikey: dbKey, "Content-Type": "application/json" };
  if (!dbKey.startsWith("sb_secret_")) dbHeaders.Authorization = `Bearer ${dbKey}`;

  return async function rpc(name, args = {}) {
    const response = await fetcher(`${dbBase}/rest/v1/rpc/${name}`, {
      method: "POST", headers: dbHeaders, body: JSON.stringify(args), signal: AbortSignal.timeout(6500),
    });
    if (!response.ok) throw new Error(`Database RPC ${name} returned ${response.status}.`);
    return response.json();
  };
}
