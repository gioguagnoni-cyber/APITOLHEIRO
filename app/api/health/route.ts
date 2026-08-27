import { NextResponse } from "next/server";
import { hasServerConfiguration } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    ok: true,
    configured: hasServerConfiguration(),
    timestamp: new Date().toISOString(),
  });
}
