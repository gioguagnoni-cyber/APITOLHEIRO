const optional = (name: string) => process.env[name]?.trim() || undefined;

export const config = {
  apiFootballBaseUrl: optional("API_FOOTBALL_BASE_URL") || "https://v3.football.api-sports.io",
  apiFootballKey: optional("API_FOOTBALL_KEY"),
  dailyLimit: Number.parseInt(optional("API_FOOTBALL_DAILY_LIMIT") || "90", 10),
  maxApiRequestsPerRun: Number.parseInt(optional("API_FOOTBALL_MAX_REQUESTS_PER_RUN") || "9", 10),
  refreshSecret: optional("CRON_SECRET") || optional("DASHBOARD_REFRESH_SECRET"),
  supabaseSecretKey: optional("SUPABASE_SECRET_KEY") || optional("SUPABASE_SERVICE_ROLE_KEY"),
  supabaseUrl: optional("SUPABASE_URL"),
};

export const hasServerConfiguration = () =>
  Boolean(config.apiFootballKey && config.supabaseUrl && config.supabaseSecretKey);
