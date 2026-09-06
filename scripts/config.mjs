export function publicConfig(env) {
  const url = new URL(env.SUPABASE_URL || "invalid");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw Error("SUPABASE_URL must be an HTTPS project origin.");
  const key = env.SUPABASE_PUBLISHABLE_KEY || "";
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key))
    throw Error(
      "Use a Supabase sb_publishable_ key, never a secret/service-role key.",
    );
  const admin = env.SUPABASE_ADMIN_USER_ID || "";
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      admin,
    )
  )
    throw Error(
      "Set SUPABASE_ADMIN_USER_ID to the existing authorized user UUID.",
    );
  return { url: url.origin, key, admin };
}
