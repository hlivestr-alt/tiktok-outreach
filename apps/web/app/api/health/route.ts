export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    status: "healthy",
    service: "web",
    version: process.env.APP_VERSION ?? "development",
    buildTimestamp: process.env.BUILD_TIMESTAMP ?? "unknown"
  });
}
