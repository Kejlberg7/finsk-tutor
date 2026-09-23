import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { getLearningSnapshot } from "@/lib/learning";

export async function GET(request: Request) {
  if (!(await getSessionFromRequest(request))) {
    return NextResponse.json({ error: "Ikke logget ind." }, { status: 401 });
  }

  return NextResponse.json(await getLearningSnapshot(), {
    headers: { "Cache-Control": "no-store" },
  });
}
