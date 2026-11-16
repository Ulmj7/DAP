import {afterEach,expect,it,vi} from "vitest";
import {placeCard} from "./placement.js";
import {createAvailabilityFeed} from "./availability.js";
import {createTargets} from "./targets.js";
import {createOverlay} from "./overlay.js";
import {createSemanticRegistry} from "../semantic/registry.js";
const registry=createSemanticRegistry({routes:["profile"],elements:[{id:"profile.name",route:"profile",role:"textbox",label:"Name",description:"Display name",privacy:"public",operations:["highlight","input"]}]});
function input(){const el=document.createElement("input");el.setAttribute("data-ai-id","profile.name");return el;}
const cleanup:(()=>void)[]=[];afterEach(()=>{for(const stop of cleanup.splice(0))stop();document.body.replaceChildren();});
it.each([
 [{left:100,top:100,width:100,height:30},{width:200,height:100},"below"],
 [{left:100,top:700,width:100,height:30},{width:200,height:100},"above"],
 [{left:100,top:200,width:100,height:400},{width:200,height:400},"beside"],
 [{left:1000,top:200,width:100,height:400},{width:200,height:400},"beside"],
] as const)("pure placement chooses room on a side",(target,card,placement)=>{const result=placeCard({target,card,viewport:{width:1200,height:800}});expect(result.placement).toBe(placement);expect(result.left).toBeGreaterThanOrEqual(8);expect(result.top).toBeGreaterThanOrEqual(8);if(placement==="below")expect(result.top).toBeGreaterThanOrEqual(target.top+target.height);if(placement==="above")expect(result.top+card.height).toBeLessThanOrEqual(target.top);if(placement==="beside")expect(result.left+card.width<=target.left||result.left>=target.left+target.width).toBe(true);});
it("clamps and docks compact cards away from the target",()=>{
 for(const top of [20,700]){const p=placeCard({target:{left:0,top,width:300,height:44},card:{width:336,height:240},viewport:{width:390,height:844}});expect(p.left).toBe(8);expect(p.placement).toBe(top===20?"bottom":"top");expect(p.top+240).toBeLessThanOrEqual(836);}
 const p=placeCard({target:{left:2000,top:2000,width:1,height:1},card:{width:300,height:100},viewport:{width:900,height:600}});expect(p.left).toBeLessThanOrEqual(592);expect(p.top).toBeLessThanOrEqual(492);
});
it("availability emits only registered changes, refreshes after render, and unsubscribes",async()=>{
 const root=document.createElement("div");document.body.append(root);const events:unknown[]=[];const targets=createTargets(root,registry);const feed=createAvailabilityFeed({registry,targets,dispatch:e=>events.push(e)});cleanup.push(feed.destroy);
 expect(events).toEqual([]);const unknown=document.createElement("button");unknown.setAttribute("data-ai-id","unregistered.id");root.append(input(),unknown);feed.refresh();feed.refresh();expect(events).toEqual([{type:"targetAvailable",id:"profile.name"}]);
 root.querySelector("input")!.remove();await Promise.resolve();expect(events).toEqual([{type:"targetAvailable",id:"profile.name"},{type:"targetGone",id:"profile.name"}]);feed.destroy();root.replaceChildren(input());await Promise.resolve();expect(events).toHaveLength(2);
});
it("content overlays remain nonmodal, value-free, verifying-aware and detach cleanly",()=>{
 const root=document.createElement("div");root.replaceChildren(input());document.body.append(root);const target=createTargets(root,registry).find("profile.name")!;target.element.getBoundingClientRect=()=>({left:10,top:10,width:100,height:44,right:110,bottom:54} as DOMRect);
 const overlay=createOverlay(document);cleanup.push(overlay.hide);const cancel=vi.fn();overlay.show(target,{title:"Name",text:"<img src=x>",progress:"Step 1 of 2",hint:"Type here.",ack:false},{onCancel:cancel});
 const card=document.querySelector('[data-ai-overlay="tooltip"]')!;expect(card.getAttribute("role")).toBe("region");expect(card.hasAttribute("aria-modal")).toBe(false);expect(card.querySelector("img")).toBeNull();expect(card.textContent).toContain("Step 1 of 2");expect(card.querySelector<HTMLButtonElement>('[data-ai-overlay="ack"]')!.hidden).toBe(true);
 for(const el of Array.from(document.querySelectorAll("[data-ai-overlay]")))expect(el.hasAttribute("data-ai-ignore")).toBe(true);
 overlay.update({ack:true,ackDisabled:true,status:"Checking…"});expect(card.querySelector<HTMLButtonElement>('[data-ai-overlay="ack"]')!.disabled).toBe(true);expect(card.textContent).toContain("Checking…");
 window.dispatchEvent(new Event("scroll"));window.dispatchEvent(new Event("resize"));target.element.remove();overlay.reposition();expect(document.querySelectorAll("[data-ai-overlay]")).toHaveLength(0);
});
