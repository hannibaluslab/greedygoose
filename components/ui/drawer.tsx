"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Drawer as DrawerPrimitive } from "vaul";

import { cn } from "@/lib/utils";

/**
 * vaul bottom drawer (shadcn's wrapper, from NYM), phone only and capped at the app's 430px
 * column. SheetShell is the one caller: it runs it non-modal, where vaul renders no overlay,
 * so SheetShell draws the dim itself.
 */
function Drawer({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Root>) {
  return <DrawerPrimitive.Root data-slot="drawer" {...props} />;
}

/**
 * The drawer's panel. vaul 1.1.2 never passes `modal` on to the Radix dialog it renders, so every sheet was a modal
 * Radix dialog even with `modal={false}`: it set `pointer-events: none` on the body and on every sheet under the newest
 * one, trapped focus and hid the rest of the page from the accessibility tree. A hop from one sheet to the next keeps
 * two of them mounted for vaul's 500ms exit, and on iPhone that stacking left taps landing under the sheet, its top bar
 * unable to drag and the app unresponsive. The panel and its title read the nearest Radix dialog, so this non-modal
 * one, open with the sheet, stands in for vaul's: SheetShell's dim covers the page instead, and closing stays
 * SheetShell's (the dim, Close, Escape, the drag).
 */
function DrawerContent({
  open,
  className,
  children,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Content> & { open: boolean }) {
  return (
    <DialogPrimitive.Root open={open} modal={false}>
      <DrawerPrimitive.Portal data-slot="drawer-portal">
        <DrawerPrimitive.Content
          data-slot="drawer-content"
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 mx-auto flex h-auto w-full max-w-[430px] flex-col rounded-t-[28px] bg-sheet text-ink shadow-sheet outline-none",
            className,
          )}
          {...props}
        >
          {children}
        </DrawerPrimitive.Content>
      </DrawerPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

// No default type styles on the title and description: tailwind-merge reads NYM's custom sizes
// (text-body-xs, text-h2…) as colours, so a default colour would silently drop the caller's size.
function DrawerTitle(props: React.ComponentProps<typeof DrawerPrimitive.Title>) {
  return <DrawerPrimitive.Title data-slot="drawer-title" {...props} />;
}

function DrawerDescription(props: React.ComponentProps<typeof DrawerPrimitive.Description>) {
  return <DrawerPrimitive.Description data-slot="drawer-description" {...props} />;
}

export { Drawer, DrawerContent, DrawerTitle, DrawerDescription };
