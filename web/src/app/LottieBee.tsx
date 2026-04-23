"use client";

import { DotLottieReact } from "@lottiefiles/dotlottie-react";

export default function LottieBee({ className = "" }: { className?: string }) {
  return (
    <div className={className} aria-hidden="true">
      <DotLottieReact
        src="/bee-lounging.lottie"
        loop
        autoplay
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  );
}
