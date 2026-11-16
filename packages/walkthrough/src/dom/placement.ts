export interface Rect {left:number;top:number;width:number;height:number}
export interface Size {width:number;height:number}
export function placeCard({target,card,viewport}:{target:Rect;card:Size;viewport:Size}):{top:number;left:number;placement:"below"|"above"|"beside"|"top"|"bottom"} {
 const margin=8,gap=12;const width=Math.min(card.width,Math.max(0,viewport.width-2*margin));const height=Math.min(card.height,Math.max(0,viewport.height-2*margin));
 const clamp=(n:number,max:number)=>Math.max(margin,Math.min(n,max-margin));
 if(viewport.width<768){const top=target.top+target.height/2>viewport.height/2;return {left:margin,top:top?margin:Math.max(margin,viewport.height-height-margin),placement:top?"top":"bottom"};}
 let left=target.left,top=target.top+target.height+gap;let placement:"below"|"above"|"beside"="below";
 if(top+height>viewport.height-margin){if(target.top-gap-height>=margin){top=target.top-gap-height;placement="above";}else if(target.left+target.width+gap+width<=viewport.width-margin){left=target.left+target.width+gap;top=target.top;placement="beside";}else if(target.left-gap-width>=margin){left=target.left-gap-width;top=target.top;placement="beside";}}
 return {left:clamp(left,viewport.width-width),top:clamp(top,viewport.height-height),placement};
}
