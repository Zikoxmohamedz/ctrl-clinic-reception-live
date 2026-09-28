export function materialPicker(input, valueInput, list, getItems, escapeHtml, onPick) {
  let shown = [], active = -1;
  const normalize = text => String(text || '').normalize('NFKC').toLocaleLowerCase().trim();
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded','false'); input.removeAttribute('aria-activedescendant'); active = -1; };
  const clear = () => { valueInput.value = ''; input.value = ''; close(); };
  function pick(item) {
    valueInput.value = item.id;
    input.value = item.name + ' — ' + item.code + ' (' + item.unit + ')';
    close(); onPick(item);
  }
  function draw() {
    const query = normalize(input.value);
    if (!query || valueInput.value) return close();
    const score = item => {
      const name=normalize(item.name),code=normalize(item.code),barcode=normalize(item.barcode);
      if(code===query||barcode===query||name===query)return 0;
      if(code.startsWith(query)||name.startsWith(query))return 1;
      if(name.split(/\s+/).some(word=>word.startsWith(query)))return 2;
      return 3;
    };
    shown = getItems().filter(item=>normalize(item.name+' '+item.code+' '+(item.barcode||'')).includes(query)).sort((a,b)=>score(a)-score(b)||a.name.localeCompare(b.name)).slice(0,20);
    active=-1;
    list.innerHTML=shown.length?shown.map((item,index)=>'<button type="button" role="option" aria-selected="false" id="receipt-choice-'+index+'" data-index="'+index+'"><b>'+escapeHtml(item.name)+'</b><small>'+escapeHtml(item.code)+' · '+escapeHtml(item.unit)+'</small></button>').join(''):'<div class="empty-state compact-empty">لا توجد أصناف مطابقة للمصدر المختار</div>';
    list.hidden=false;input.setAttribute('aria-expanded','true');
    list.querySelectorAll('[data-index]').forEach(button=>button.onclick=()=>pick(shown[Number(button.dataset.index)]));
  }
  input.oninput=()=>{valueInput.value='';input.removeAttribute('aria-activedescendant');draw();};
  input.onfocus=draw;
  input.onkeydown=event=>{
    if(event.key==='Escape'){close();return;}
    if(event.key==='Enter'&&!list.hidden){event.preventDefault();if(shown.length)pick(shown[Math.max(0,active)]);return;}
    if(!['ArrowDown','ArrowUp'].includes(event.key))return;
    event.preventDefault();if(list.hidden)draw();if(list.hidden||!shown.length)return;
    active=(active+(event.key==='ArrowDown'?1:-1)+shown.length)%shown.length;
    list.querySelectorAll('[data-index]').forEach((button,i)=>{button.setAttribute('aria-selected',String(i===active));if(i===active){input.setAttribute('aria-activedescendant',button.id);button.scrollIntoView({block:'nearest'});}});
  };
  input.closest('.search-wrap').addEventListener('focusout',()=>setTimeout(()=>{if(!input.closest('.search-wrap').contains(document.activeElement))close();},0));
  list.onmousedown=event=>event.preventDefault();
  return {clear,close};
}
