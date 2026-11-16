import{a as z,b as q}from"./c-HIQMD6DZ.js";import{a as k}from"./c-YGWGG2BQ.js";import{g as j}from"./c-7CK3K33G.js";import{a as I}from"./c-RLRTF2YY.js";import"./c-CADHRLVD.js";import{F as P}from"./c-WFT3AQKK.js";import"./c-DC5LPAJS.js";import"./c-SODGPT37.js";import{b as d}from"./c-IDQHJAGS.js";import{A as x,B as E}from"./c-U5NKMHWB.js";import"./c-BFFL3KIO.js";import"./c-VNY4EDZD.js";import"./c-5BQSVVBC.js";import"./c-ENWVGY26.js";import"./c-6P75ZRUL.js";import{Db as O,Fa as N,Fb as F,Q as L,T as A,V as f,Va as U,rb as M}from"./c-I2KZQKPG.js";import{a as B,b as X}from"./c-C4VIZEEJ.js";import"./c-FKNR4ZMH.js";import{b as v}from"./c-6PQBVLMM.js";import"./c-SKPVY2NK.js";import"./c-ZQKQTA45.js";import"./c-4Q26OXXU.js";import"./c-RBGC4TAE.js";import"./c-ZGKGPQLM.js";import{S as D,y as R}from"./c-BWZ3ZKUB.js";import"./c-YGPDNZMD.js";import{f as _}from"./c-CJFUG6WT.js";var t=_(X(),1);var a=_(B(),1);var Y=d.img`
  && {
    height: ${e=>e.size==="sm"?"65px":"140px"};
    width: ${e=>e.size==="sm"?"65px":"140px"};
    border-radius: 16px;
    margin-bottom: 12px;
  }
`,Z=e=>{if(!R(e))return e;try{let i=D(e);return i.includes("\uFFFD")?e:i}catch{return e}},ee=e=>{try{let i=v.decode(e),o=new TextDecoder().decode(i);return o.includes("\uFFFD")?e:o}catch{return e}},te=e=>{let{types:i,primaryType:o,...l}=e.typedData;return(0,t.jsxs)(t.Fragment,{children:[(0,t.jsx)(ae,{data:l}),(0,t.jsx)(k,{text:(s=e.typedData,JSON.stringify(s,null,2)),itemName:"full payload to clipboard"})," "]});var s},re=({method:e,messageData:i,copy:o,iconUrl:l,isLoading:s,success:p,walletProxyIsLoading:g,errorMessage:u,isCancellable:h,onSign:c,onCancel:C,onClose:m})=>(0,t.jsx)(I,{title:o.title,subtitle:o.description,showClose:!0,onClose:m,icon:P,iconVariant:"subtle",helpText:u?(0,t.jsx)(oe,{children:u}):void 0,primaryCta:{label:o.buttonText,onClick:c,disabled:s||p||g,loading:s},secondaryCta:h?{label:"Not now",onClick:C,disabled:s||p||g}:void 0,watermark:!0,children:(0,t.jsxs)(j,{children:[l?(0,t.jsx)(Y,{style:{alignSelf:"center"},size:"sm",src:l,alt:"app image"}):null,(0,t.jsxs)(ie,{children:[e==="personal_sign"&&(0,t.jsx)(V,{children:Z(i)}),e==="eth_signTypedData_v4"&&(0,t.jsx)(te,{typedData:i}),e==="solana_signMessage"&&(0,t.jsx)(V,{children:ee(i)})]})]})}),Ee={component:()=>{let{authenticated:e}=F(),{initializeWalletProxy:i,closePrivyModal:o}=N(),{navigate:l,data:s,onUserCloseViaDialogOrKeybindRef:p}=O(),[g,u]=(0,a.useState)(!0),[h,c]=(0,a.useState)(""),[C,m]=(0,a.useState)(),[S,T]=(0,a.useState)(null),[J,w]=(0,a.useState)(!1);(0,a.useEffect)((()=>{e||l("LandingScreen")}),[e]),(0,a.useEffect)((()=>{i(M).then((r=>{u(!1),r||(c("An error has occurred, please try again."),m(new E(new x(h,f.E32603_DEFAULT_INTERNAL_ERROR.eipCode))))}))}),[]);let{method:W,data:$,confirmAndSign:G,onSuccess:H,onFailure:K,uiOptions:n}=s.signMessage,Q={title:n?.title||"Sign message",description:n?.description||"Signing this message will not cost you any fees.",buttonText:n?.buttonText||"Sign and continue"},y=r=>{r?H(r):K(C||new E(new x("The user rejected the request.",f.E4001_USER_REJECTED_REQUEST.eipCode))),o({shouldCallAuthOnSuccess:!1}),setTimeout((()=>{T(null),c(""),m(void 0)}),200)};return p.current=()=>{y(S)},(0,t.jsx)(re,{method:W,messageData:$,copy:Q,iconUrl:n?.iconUrl&&typeof n.iconUrl=="string"?n.iconUrl:void 0,isLoading:J,success:S!==null,walletProxyIsLoading:g,errorMessage:h,isCancellable:n?.isCancellable,onSign:async()=>{w(!0),c("");try{let r=await G();T(r),w(!1),setTimeout((()=>{y(r)}),U)}catch(r){console.error(r);let b=r instanceof A&&r.code===L.MISSING_MFA_ENROLLMENT?r.message:"An error has occurred, please try again.";c(b),m(new E(new x(b,f.E32603_DEFAULT_INTERNAL_ERROR.eipCode))),w(!1)}},onCancel:()=>y(null),onClose:()=>y(S)})}},ie=d.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 16px;
`,oe=d.p`
  && {
    margin: 0;
    width: 100%;
    text-align: center;
    color: var(--privy-color-error-dark);
    font-size: 14px;
    line-height: 22px;
  }
`,ae=d(q)`
  margin-top: 0;
`,V=d(z)`
  margin-top: 0;
`;export{Ee as SignRequestScreen,re as SignRequestView,Ee as default};
