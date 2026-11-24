// The chat's right-click menu, the chat side's counterpart of chat-menu on a
// terminal (Herdr's `terminal_menu` only covers terminals, so the chat draws
// its own, at the pointer, over its own pane). main.js builds the items
// (menuItems) and opens it from a right-click on the chat, or on its
// "render failed" screen, so a broken chat can still go to its terminal.
//
// An item: {label, icon?, key? ("⌥⌘T"), note? (why it's off), run?(cx)}; no
// `run`: shown disabled. {sep: true}: a divider.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { icon, uiScale } from "./util.js";

const W = 250, ROW_H = 30, PAD = 5, SEP_H = 9, EDGE = 6;

/** Where a right-click opens the menu: layout px within the chat, and the chat's size (window pt in `size`). */
export function menuAt(e, size) {
  const k = uiScale();
  const p = e.local_position ?? e.position ?? { x: 0, y: 0 };
  return { x: p.x / k, y: p.y / k, w: (size?.w ?? 0) / k, h: (size?.h ?? 0) / k };
}

/** The open menu: an absolute card in the chat's root (which is relative). o: {onPick(item, cx), onClose(cx)}. */
export function contextMenu(at, items, t, o) {
  const h = items.reduce((n, it) => n + (it.sep ? SEP_H : ROW_H), 2 * PAD + 2);
  // Kept inside the chat: left of the pointer near the right edge, above it near the bottom.
  const x = at.w ? Math.max(EDGE, Math.min(at.x, at.w - W - EDGE)) : at.x;
  const y = at.h && at.y + h > at.h - EDGE ? Math.max(EDGE, at.y - h) : at.y;
  return v_flex().id("chat-ctx-menu").absolute().top(y).left(x).w(W).p(PAD).rounded(10)
    .border_1().border_color(t.border).bg(t.popover).shadow_md().text_size(12.8).text_color(t.foreground)
    .on_mouse_down_out((_e, cx) => o.onClose(cx))
    // A press inside isn't the chat's (the composer would take the focus, the timeline a drag).
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
    .children(items.map((it, i) => it.sep
      ? div().mx(4).my(4).h(1).bg(t.border)
      : h_flex().id(`chat-ctx-${i}`).h(ROW_H).px(8).gap(9).rounded(7).items_center()
        .text_color(it.run ? t.foreground : t.dim)
        .when(Boolean(it.run), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { cx.stop_propagation(); o.onPick(it, cx); }))
        .child(div().w(14).flex_none().text_color(t.muted).child(it.icon ? icon(it.icon, 14) : ""))
        .child(div().flex_1().min_w(0).truncate().child(it.label))
        .when(Boolean(it.note ?? it.key), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(it.note ?? it.key)))));
}
