import { NextResponse } from "next/server";
import { runDailyAnalysis } from "@/lib/analysis";
import { config, hasServerConfiguration } from "@/lib/config";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!config.refreshSecret || authorization !== "Bearer " + config.refreshSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasServerConfiguration()) {
    return NextResponse.json({ error: "Server configuration is incomplete." }, { status: 503 });
  }

  try {
    const candidates = await runDailyAnalysis();
    return NextResponse.json({ ok: true, analyzed: candidates.length, generatedAt: new Date().toISOString() });
  } catch (error) {
    console.error("Daily analysis failed", error);
    return NextResponse.json({ error: "Analysis run failed." }, { status: 500 });
  }
}
