import worker from "../worker.js";

export async function onRequest({ request, env, next }) {
  if (!new URL(request.url).pathname.startsWith("/api/")) return next();
  return worker.fetch(request, env);
}
