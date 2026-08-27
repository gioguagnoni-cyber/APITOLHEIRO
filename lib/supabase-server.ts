import { createClient } from "@supabase/supabase-js";
import { config } from "./config";

export const getSupabaseAdmin = () => {
  if (!config.supabaseUrl || !config.supabaseSecretKey) {
    return null;
  }

  return createClient(config.supabaseUrl, config.supabaseSecretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
};
