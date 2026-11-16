(function () {
  const nav = document.getElementById('nav');

  // solid nav once the page moves
  const onScroll = () => nav.classList.toggle('is-scrolled', scrollY > 12);
  addEventListener('scroll', onScroll, { passive: true }); onScroll();

  // dropdowns: hover on fine pointers, click/keyboard everywhere
  const dds = [...document.querySelectorAll('.dd')];
  const setDD = (dd, open) => { dd.classList.toggle('is-open', open); dd.querySelector('.dd-btn').setAttribute('aria-expanded', open); };
  const closeAll = except => dds.forEach(d => d !== except && setDD(d, false));
  const fine = matchMedia('(hover: hover) and (pointer: fine)');
  dds.forEach(dd => {
    let t;
    const btn = dd.querySelector('.dd-btn');
    btn.addEventListener('click', () => { const o = !dd.classList.contains('is-open'); closeAll(dd); setDD(dd, o); });
    dd.addEventListener('mouseenter', () => { if (!fine.matches) return; clearTimeout(t); closeAll(dd); setDD(dd, true); });
    dd.addEventListener('mouseleave', () => { if (!fine.matches) return; t = setTimeout(() => setDD(dd, false), 140); });
    dd.addEventListener('focusout', e => { if (!dd.contains(e.relatedTarget)) setDD(dd, false); });
  });
  document.addEventListener('click', e => { if (!e.target.closest('.dd')) closeAll(); });

  // mobile menu
  const burger = nav.querySelector('.burger'), mnav = document.getElementById('mnav');
  const setM = open => {
    nav.classList.toggle('is-open', open); mnav.hidden = !open;
    burger.setAttribute('aria-expanded', open); burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    document.body.style.overflow = open ? 'hidden' : '';
  };
  burger.addEventListener('click', () => setM(mnav.hidden));
  mnav.addEventListener('click', e => { if (e.target.closest('a')) setM(false); });
  matchMedia('(min-width: 1081px)').addEventListener('change', e => { if (e.matches) setM(false); });

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const open = dds.find(d => d.classList.contains('is-open'));
    if (open) { setDD(open, false); open.querySelector('.dd-btn').focus(); }
    if (!mnav.hidden) { setM(false); burger.focus(); }
  });

})();
