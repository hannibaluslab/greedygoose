"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

/**
 * The account's address as a QR code (NYM's AddFundsSheet), in the board's 148px sand square (AddMoney). The plain
 * address is what every wallet and exchange scanner reads.
 */
export function AddressQr({ address }: { address: `0x${string}` }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    QRCode.toDataURL(address, {
      errorCorrectionLevel: "M",
      margin: 0,
      scale: 8,
      color: { dark: "#0e0d0b", light: "#ebe6db" },
    })
      .then((url) => live && setSrc(url))
      .catch(() => live && setSrc(null));
    return () => {
      live = false;
    };
  }, [address]);

  return (
    <div className="flex size-[148px] items-center justify-center self-center rounded-[14px] bg-app-sub p-3">
      {/* eslint-disable-next-line @next/next/no-img-element -- a data URL made in the browser */}
      {src && <img src={src} alt="QR code of your address" className="size-full [image-rendering:pixelated]" />}
    </div>
  );
}
