"use client";

import ButtonWithConnectWalletFallback from "components/header/wallet-button/ConnectWalletButton";
import Text from "components/text";
import { useDokuWallet } from "context/wallet-context/DokuWalletProvider";
import { motion } from "framer-motion";
import { LINKS } from "lib/env";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ROUTES } from "router/routes";
import { useScramble } from "use-scramble";

import { Flex } from "@/containers";

import { createSession } from "./session";

const ClientVerifyPage = () => {
  const { address, disconnect } = useDokuWallet();
  const connected = Boolean(address);
  const [verified, setVerified] = useState<boolean | null>(null);

  const { ref, replay } = useScramble({
    text:
      verified === true ? "Access Granted" : verified === false ? "Access Denied" : "Verifying...",
    overdrive: false,
    overflow: true,
    speed: 0.6,
    playOnMount: true,
  });

  const { ref: backRef, replay: replayBack } = useScramble({
    text: "Back",
    overdrive: false,
    overflow: true,
    speed: 0.6,
  });

  const verify = useCallback(
    async (walletAddress: `0x${string}`) => {
      const res = await createSession(walletAddress);
      setVerified(res);
      replay();
    },
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
    []
  );

  useEffect(() => {
    if (address) {
      verify(address);
    }
  }, [address, verify]);

  useEffect(() => {
    setTimeout(() => {
      replay();
    }, 300);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [verified]);

  return (
    <>
      <div
        className="absolute top-0 left-0 w-[100dvw] h-[100dvh] bg-canvas z-50 overflow-hidden grid"
        style={{
          gridTemplateRows: "19fr 1fr",
        }}
      >
        <div className="flex items-center justify-center w-full h-full">
          <div className="flex flex-col justify-begin uppercase text-ec-blue gap-4 text-2xl">
            {connected && verified === false && (
              <motion.div
                onMouseEnter={replayBack}
                animate={{ x: 0, y: -60 }}
                initial={{ x: 2000, y: -60 }}
                className="absolute flex flex-row px-2.5 hover:cursor-pointer min-w-[12ch] top-[50%]"
                onClick={() => {
                  setVerified(null);
                  disconnect();
                }}
                transition={{
                  type: "just",
                  duration: 0.3,
                }}
              >
                <span>{"<<"}&nbsp;</span>
                <span ref={backRef}>Back</span>
              </motion.div>
            )}
            <ButtonWithConnectWalletFallback>
              <div className="flex flex-row uppercase mt-[8ch]">
                <span className="px-2.5">{"{"}</span>
                <span ref={ref} onMouseEnter={replay} />
                <span className="px-2.5">{"}"}</span>
              </div>
            </ButtonWithConnectWalletFallback>
          </div>
        </div>
        <Flex justifyContent="center" className="w-[100dvw]">
          <Link href={LINKS?.tos ?? ROUTES["not-found"]}>
            <Text
              textScale="display6"
              $fontWeight="bold"
              /* 8px on a phone was the smallest type in the product, on the one link a visitor
                 has to read before agreeing to anything. 12px is the label floor everywhere else. */
              fontSize={{ _: "12px", tablet: "15px" }}
              textTransform="uppercase"
              py={{ _: "16px", tablet: "24px" }}
            >
              TERMS OF USE
            </Text>
          </Link>
        </Flex>
      </div>
    </>
  );
};

export default ClientVerifyPage;
