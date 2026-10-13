const token = process.env.TUTOR_READ_API_TOKEN;
if (!token) {
  console.error("TUTOR_READ_API_TOKEN mangler i .env.local.");
  process.exit(1);
}

const baseUrl = process.env.TUTOR_READ_API_BASE_URL || "https://finsk-tutor.vercel.app";
const response = await fetch(`${baseUrl}/api/assistant/context?sessions=5&notes=50`, {
  headers: { Authorization: `Bearer ${token}` },
  cache: "no-store",
});

if (!response.ok) {
  const body = await response.json().catch(() => null);
  console.error(body?.error || `Tutor-API svarede med HTTP ${response.status}.`);
  process.exit(1);
}

console.log(JSON.stringify(await response.json(), null, 2));
