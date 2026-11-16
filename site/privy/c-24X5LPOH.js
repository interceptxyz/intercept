import{d as R,f as U,k as W,m as E,n as H}from"./c-ABCB2XLM.js";import{a as T}from"./c-RESHSXSB.js";import"./c-2PKO5QWK.js";import{h as _}from"./c-7CK3K33G.js";import{a as o}from"./c-CADHRLVD.js";import"./c-DC5LPAJS.js";import{d as I}from"./c-SODGPT37.js";import{ka as N}from"./c-ENOIZEGQ.js";import"./c-KFIQ26F7.js";import"./c-3RWNX7T6.js";import"./c-XAUFEB5R.js";import"./c-QNBXZGQD.js";import"./c-CI4Y2PA4.js";import"./c-EZ5IGE7Q.js";import"./c-5DCNSKKP.js";import"./c-FLK4MXNH.js";import{a as S,b as n}from"./c-IDQHJAGS.js";import"./c-OT5RQ55S.js";import"./c-U5NKMHWB.js";import"./c-BFFL3KIO.js";import"./c-VNY4EDZD.js";import"./c-5BQSVVBC.js";import{j as P}from"./c-ENWVGY26.js";import"./c-6P75ZRUL.js";import{Db as C,Fa as x,Fb as k,Oa as A}from"./c-I2KZQKPG.js";import{a as K,b as Y}from"./c-C4VIZEEJ.js";import"./c-FKNR4ZMH.js";import"./c-6PQBVLMM.js";import"./c-SKPVY2NK.js";import"./c-ZQKQTA45.js";import"./c-4Q26OXXU.js";import"./c-RBGC4TAE.js";import"./c-ZGKGPQLM.js";import"./c-BWZ3ZKUB.js";import"./c-YGPDNZMD.js";import{f as b}from"./c-CJFUG6WT.js";var e=b(Y(),1);var a=b(K(),1);var ne={component:()=>{let[s,m]=(0,a.useState)(!0),{authenticated:p,user:O}=k(),{walletProxy:u,closePrivyModal:y,createAnalyticsEvent:v,client:V}=x(),{navigate:$,data:j,onUserCloseViaDialogOrKeybindRef:F}=C(),[l,z]=(0,a.useState)(void 0),[f,d]=(0,a.useState)(""),[c,w]=(0,a.useState)(!1),{entropyId:h,entropyIdVerifier:M,onCompleteNavigateTo:g,onSuccess:q,onFailure:B}=j.recoverWallet,i=(r="User exited before their wallet could be recovered")=>{y({shouldCallAuthOnSuccess:!1}),B(typeof r=="string"?new P(r):r)};return F.current=i,(0,a.useEffect)((()=>{if(!p)return i("User must be authenticated and have a Privy wallet before it can be recovered")}),[p]),(0,e.jsxs)(o,{children:[(0,e.jsx)(o.Header,{icon:T,title:"Enter your password",subtitle:"Please provision your account on this new device. To continue, enter your recovery password.",showClose:!0,onClose:i}),(0,e.jsx)(o.Body,{children:(0,e.jsx)(G,{children:(0,e.jsxs)("div",{children:[(0,e.jsxs)(U,{children:[(0,e.jsx)(R,{type:s?"password":"text",onChange:r=>(t=>{t&&z(t)})(r.target.value),disabled:c,style:{paddingRight:"2.3rem"}}),(0,e.jsx)(W,{style:{right:"0.75rem"},children:s?(0,e.jsx)(E,{onClick:()=>m(!1)}):(0,e.jsx)(H,{onClick:()=>m(!0)})})]}),!!f&&(0,e.jsx)(J,{children:f})]})})}),(0,e.jsxs)(o.Footer,{children:[(0,e.jsx)(o.HelpText,{children:(0,e.jsxs)(_,{children:[(0,e.jsx)("h4",{children:"Why is this necessary?"}),(0,e.jsx)("p",{children:"You previously set a password for this wallet. This helps ensure only you can access it"})]})}),(0,e.jsx)(o.Actions,{children:(0,e.jsx)(L,{loading:c||!u,disabled:!l,onClick:async()=>{w(!0);let r=await V.getAccessToken(),t=A(O,h);if(!r||!t||l===null)return i("User must be authenticated and have a Privy wallet before it can be recovered");try{v({eventName:"embedded_wallet_recovery_started",payload:{walletAddress:t.address}}),await u?.recover({accessToken:r,entropyId:h,entropyIdVerifier:M,recoveryPassword:l}),d(""),g?$(g):y({shouldCallAuthOnSuccess:!1}),q?.(t),v({eventName:"embedded_wallet_recovery_completed",payload:{walletAddress:t.address}})}catch(D){N(D)?d("Invalid recovery password, please try again."):d("An error has occurred, please try again.")}finally{w(!1)}},$hideAnimations:!h&&c,children:"Recover your account"})}),(0,e.jsx)(o.Watermark,{})]})]})}},G=n.div`
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
`,J=n.div`
  line-height: 20px;
  height: 20px;
  font-size: 13px;
  color: var(--privy-color-error);
  text-align: left;
  margin-top: 0.5rem;
`,L=n(I)`
  ${({$hideAnimations:s})=>s&&S`
      && {
        /* Remove animations because the recoverWallet task on the iframe partially
           blocks the renderer, so the animation stutters and doesn't look good */
        transition: none;
      }
    `}
`;export{ne as PasswordRecoveryScreen,ne as default};
