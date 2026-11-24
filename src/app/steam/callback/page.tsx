"use client";
import { useState } from "react";
import { api } from "@/lib/client-api";

// Steam's cross-site GET never writes data. A same-origin POST supplies the
// existing Strict session cookie and request header after the user returns.
export default function SteamCallback() {
  const [message,setMessage]=useState("已从 Steam 返回。请在当前登录会话中完成验证。"),[busy,setBusy]=useState(false),[done,setDone]=useState(false);
  return <main className="panel"><h1>完成 Steam 账号验证</h1><p role="status">{message}</p>
    {!done&&<button disabled={busy} onClick={async()=>{
      setBusy(true);
      try{const r=await api<{steamId:string}>("steam/account/complete","POST",{query:window.location.search.slice(1)});
        setMessage(`已验证 Steam 账号 ${r.steamId}。返回游戏库后打开 Steam 预览，即可确认导入。`);setDone(true);
        window.history.replaceState(null,"","/steam/callback");
      }catch(e){setMessage((e as Error).message);}finally{setBusy(false);}
    }}>完成验证</button>} <a href="/">返回游戏库</a>
  </main>;
}
