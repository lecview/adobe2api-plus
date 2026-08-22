import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** 合并 team 后台组件的 Tailwind class，保留调用方的覆盖样式。 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
