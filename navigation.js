// Keep the same controls, handlers and live counter elements in both layouts.
export function initResponsiveNavigation() {
  const compact = window.matchMedia('(max-width: 940px)');
  const menu = document.getElementById('mobile-menu');
  const trigger = document.getElementById('mobile-menu-trigger');
  const utilities = document.getElementById('mobile-utilities');
  const rail = document.getElementById('planning-navigation');
  const railActions = document.getElementById('rail-actions');
  const headerActions = document.getElementById('header-actions');
  const tools = document.getElementById('navigation-tools');
  const status = document.getElementById('dataset-label');
  const panelToggle = document.getElementById('panel-toggle');
  let compactLayout = compact.matches;
  let focusAtBreakpoint;

  // Some browsers blur an element hidden by the new CSS before notifying matchMedia.
  document.addEventListener('focusout', event => {
    if (compact.matches !== compactLayout &&
        (event.target === trigger || event.target === status || tools.contains(event.target))) {
      focusAtBreakpoint = event.target;
    }
  });

  function arrange() {
    const focused = document.activeElement === document.body && focusAtBreakpoint
      ? focusAtBreakpoint : document.activeElement;
    focusAtBreakpoint = null;
    compactLayout = compact.matches;
    menu.open = false;
    if (compact.matches) {
      headerActions.append(panelToggle);
      utilities.append(tools);
      if (focused === status || tools.contains(focused)) trigger.focus();
      else if (focused === panelToggle) panelToggle.focus();
    } else {
      rail.append(tools);
      railActions.append(panelToggle);
      if (focused === trigger) rail.querySelector('[aria-current="page"]').focus();
      else if (focused === status || tools.contains(focused)) focused.focus();
    }
  }

  // Return focus before the action runs so a native dialog remembers the visible trigger.
  utilities.addEventListener('click', event => {
    if (menu.open && event.target.closest('button')) {
      menu.open = false;
      trigger.focus();
    }
  }, {capture: true});
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menu.open) {
      event.preventDefault();
      menu.open = false;
      trigger.focus();
    }
  });
  document.addEventListener('pointerdown', event => {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
  menu.addEventListener('focusout', event => {
    if (menu.open && event.relatedTarget && !menu.contains(event.relatedTarget)) menu.open = false;
  });

  arrange();
  compact.addEventListener('change', arrange);
}
