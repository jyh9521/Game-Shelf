export async function api<T>(path: string, method = "GET", data?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method, credentials: "same-origin", cache: "no-store",
    headers: method === "GET" ? {} : { "Content-Type": "application/json", "x-gameshelf-request": "1" },
    body: data === undefined ? undefined : JSON.stringify(data)
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.details?.join("；") ?? value.error ?? "请求失败");
  return value;
}
