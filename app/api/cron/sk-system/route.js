import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
/** Cron jobs disabled by request — all scheduled cron endpoints are no-ops. */
async function handle() {
  return NextResponse.json({ ok: true, disabled: true, reason: "All cron jobs have been removed/disabled" });
}
export const GET = handle;
export const POST = handle;
