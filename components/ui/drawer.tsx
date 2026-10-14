"use client";

import * as React from "react";
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

function DrawerContent({ className, children, ...props }: React.ComponentProps<typeof DrawerPrimitive.Content>) {
  return (
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
