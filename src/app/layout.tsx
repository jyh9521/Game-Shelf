import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "GameShelf · 个人游戏库", description: "属于你的游戏收藏，安放在自己的服务器。" };
export default function Layout({children}:{children:React.ReactNode}) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
