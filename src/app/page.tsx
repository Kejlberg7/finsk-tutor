import { redirect } from "next/navigation";
import VoiceConsole from "@/components/voice-console";
import { getSession } from "@/lib/auth";

export default async function HomePage() {
  if (!(await getSession())) redirect("/login");
  return <VoiceConsole />;
}
