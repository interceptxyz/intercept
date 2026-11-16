// Privy island for app.intercepting.xyz. Bundled by build.mjs into site/privy.js.
// Exposes window.ixPrivy = { ready, login(methods?), sendCode, loginWithCode, logout() } and fires
// "ix:signed-in" once Privy's access token has been exchanged for our session cookie.
import React, { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider, usePrivy, useLogin, useLoginWithEmail } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";

const APP_ID = "cmwjeg3na00rq0gl2wkxypc9n"; // public identifier

function Bridge() {
  const { ready, authenticated, getAccessToken, logout } = usePrivy();
  const exchanging = useRef(false);

  async function exchange() {
    if (exchanging.current) return;
    exchanging.current = true;
    try {
      const token = await getAccessToken();
      const r = await fetch("/v1/auth/privy", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j.error && j.error.message) || "Sign-in failed.");
      window.dispatchEvent(new CustomEvent("ix:signed-in", { detail: j }));
    } catch (e) {
      window.dispatchEvent(new CustomEvent("ix:error", { detail: { message: e.message } }));
    } finally { exchanging.current = false; }
  }

  const { login } = useLogin({
    onComplete: () => exchange(),
    onError: err => { if (err !== "exited_auth_flow") window.dispatchEvent(new CustomEvent("ix:error", { detail: { message: "Sign-in was not completed." } })); },
  });

  const email = useLoginWithEmail({
    onComplete: () => exchange(),
    onError: () => window.dispatchEvent(new CustomEvent("ix:error", { detail: { message: "That code did not work. Check it and try again." } })),
  });

  useEffect(() => {
    window.ixPrivy = {
      sendCode: address => email.sendCode({ email: address }),
      loginWithCode: code => email.loginWithCode({ code }),
      ready,
      authenticated,
      login: methods => (methods ? login({ loginMethods: methods }) : login()),
      logout: () => logout(),
      exchange,
    };
    if (ready) window.dispatchEvent(new CustomEvent("ix:privy-ready", { detail: { authenticated } }));
  }, [ready, authenticated, email.sendCode, email.loginWithCode]);

  return null;
}

const el = document.createElement("div");
el.id = "ix-privy";
document.body.appendChild(el);
createRoot(el).render(
  <PrivyProvider
    appId={APP_ID}
    config={{
      loginMethods: ["email", "wallet"],
      appearance: {
        theme: "dark",
        accentColor: "#eef1f4",
        logo: "https://www.intercepting.xyz/mark.png",
        landingHeader: "Sign in to Intercept",
        walletChainType: "ethereum-and-solana",
        walletList: ["phantom", "solflare", "backpack", "detected_solana_wallets", "metamask", "detected_ethereum_wallets"],
      },
      externalWallets: { solana: { connectors: toSolanaWalletConnectors() } },
      embeddedWallets: { ethereum: { createOnLogin: "off" }, solana: { createOnLogin: "off" } },
    }}
  >
    <Bridge />
  </PrivyProvider>
);
