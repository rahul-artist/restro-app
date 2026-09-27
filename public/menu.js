let menu=[], tableToken=new URLSearchParams(location.search).get("table"), sessionId=null, cart=[];
const $=id=>document.getElementById(id), money=n=>"₹"+Number(n).toLocaleString("en-IN",{minimumFractionDigits:0,maximumFractionDigits:2});
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
async function init(){
 if(!tableToken){$("menu").innerHTML="<div class='item'>This menu link is missing a table QR token.</div>";return}
 const [m,t]=await Promise.all([fetch("/api/public/menu").then(r=>r.json()),fetch("/api/public/table/"+encodeURIComponent(tableToken)).then(r=>r.json())]);
 if(m.error||t.error) throw new Error(m.error||t.error);
 menu=m.categories;sessionId=t.sessionId;$("rname").textContent=m.restaurant.name;$("table").textContent=t.table.name+" · Scan again anytime to add another order";
 render(); updateCount();
}
function render(){
 const q=$("search").value.toLowerCase();
 const cats=menu.map(c=>({...c,items:c.items.filter(x=>!q||x.name.toLowerCase().includes(q)||(x.description||"").toLowerCase().includes(q))})).filter(c=>c.items.length);
 $("cats").innerHTML=cats.map(c=>`<button onclick="document.getElementById('cat-${c.id}').scrollIntoView()">${esc(c.name)}</button>`).join("");
 $("menu").innerHTML=cats.map(c=>`<section class="category" id="cat-${c.id}"><h2>${esc(c.name)}</h2>${c.items.map(x=>itemHtml(x)).join("")}</section>`).join("");
}
function itemHtml(x){return `<article class="item"><img src="${esc(x.imageUrl||"/images/food.svg")}" alt="${esc(x.name)}"><div class="info"><div class="name">${esc(x.name)}</div><div class="desc">${esc(x.description||"")}</div><div class="row"><span class="price">${money(x.price)}</span><span class="${x.veg?"veg":"nonveg"}">${x.veg?"VEG":"NON-VEG"}</span><button class="add" onclick="customize('${x.id}')">Add</button></div></div></article>`}
function findItem(id){for(const c of menu){const x=c.items.find(i=>i.id===id);if(x)return x}}
function customize(id){
 const x=findItem(id);$("modalBody").innerHTML=`<h2>${esc(x.name)}</h2><p>${esc(x.description||"")}</p><div><b>Customize</b>${x.customizations.map(c=>`<label class="choice"><span>${esc(c.name)}</span><span>+${money(c.extraPrice)} <input type="checkbox" value="${c.id}"></span></label>`).join("")||"<p>No customization options.</p>"}
 <label>Quantity <input id="mqty" type="number" min="1" max="50" value="1" style="width:70px;padding:8px"></label><br><label>Special instructions<textarea id="mnote" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px" placeholder="Less salt, extra spicy..."></textarea></label><br><button class="primary" onclick="addToCart('${x.id}')">Add to cart · ${money(x.price)}</button>`;
 $("modal").classList.remove("hidden");
}
function addToCart(id){const x=findItem(id);const customs=[...document.querySelectorAll("#modalBody input[type=checkbox]:checked")].map(e=>e.value);const key=id+"|"+customs.sort().join(",");const q=Math.max(1,Math.min(50,Number($("mqty").value||1)));const note=$("mnote").value;const old=cart.find(i=>i.key===key);if(old)old.quantity=Math.min(50,old.quantity+q);else cart.push({key,menuItemId:id,quantity:q,customizations:customs,note});closeModal();updateCount();toast("Added to cart")}
function updateCount(){$("cartCount").textContent=cart.reduce((s,x)=>s+x.quantity,0)}
function openCart(){if(!cart.length){toast("Your cart is empty");return}let total=0;$("modalBody").innerHTML="<h2>Your Cart</h2>"+cart.map((x,i)=>{const m=findItem(x.menuItemId);let extra=x.customizations.reduce((s,cid)=>s+(m.customizations.find(c=>c.id===cid)?.extraPrice||0),0);const line=(m.price+extra)*x.quantity;total+=line;return `<div class="cart-line"><b>${esc(m.name)}</b><div>${money(line)} · Qty ${x.quantity}</div><div class="desc">${x.customizations.map(cid=>esc(m.customizations.find(c=>c.id===cid)?.name||"")).join(", ")}</div><button onclick="cart.splice(${i},1);openCart();updateCount()">Remove</button></div>`}).join("")+`<h3>Total ${money(total)}</h3><textarea id="orderNote" style="width:100%;padding:10px" placeholder="Order note for waiter"></textarea><br><button class="primary" onclick="placeOrder()">Place Order</button>`;$("modal").classList.remove("hidden")}
async function placeOrder(){const note=$("orderNote").value;const res=await fetch("/api/public/orders",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tableToken,items:cart,note})});const out=await res.json();if(!res.ok){toast(out.error||"Order failed");return}cart=[];updateCount();closeModal();toast("Order #"+out.orderNo+" sent to waiter");}
function closeModal(){$("modal").classList.add("hidden")}
function toast(s){$("toast").textContent=s;$("toast").classList.add("show");setTimeout(()=>$("toast").classList.remove("show"),2500)}
$("search").addEventListener("input",render);init().catch(e=>{$("menu").innerHTML="<div class='item'>Unable to load menu. Please scan the table QR again.</div>"});
