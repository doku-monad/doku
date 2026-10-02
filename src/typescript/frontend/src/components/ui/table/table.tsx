import { type HTMLMotionProps, motion } from "framer-motion";
import { cn } from "lib/utils/class-name";
import * as React from "react";

const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => (
    <table
      ref={ref}
      className={cn("w-full caption-bottom text-sm border-separate border-spacing-0", className)}
      {...props}
    />
  )
);
Table.displayName = "Table";

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead
    ref={ref}
    className={cn(
      "sticky top-0 z-10 bg-surface text-center font-forma text-[11px] uppercase " +
        "tracking-[0.08em] text-mute",
      className
    )}
    {...props}
  />
));
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody
    ref={ref}
    className={cn("table-body [&>tr:last-child>td]:border-b-0", className)}
    {...props}
  />
));
TableBody.displayName = "TableBody";

const TableFooter = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tfoot ref={ref} className={cn("border-t bg-muted/50 font-medium", className)} {...props} />
));
TableFooter.displayName = "TableFooter";

const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      "h-9 align-middle font-normal tracking-[0.08em] font-forma border-b border-line " +
        "[&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
      className
    )}
    {...props}
  />
));
TableHead.displayName = "TableHead";

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td
    ref={ref}
    className={cn(
      "align-middle text-mute border-b border-line [&:has([role=checkbox])]:pr-0 " +
        "[&>[role=checkbox]]:translate-y-[2px]",
      className
    )}
    {...props}
  />
));
TableCell.displayName = "TableCell";

const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  React.HTMLAttributes<HTMLTableCaptionElement>
>(({ className, ...props }, ref) => (
  <caption ref={ref} className={cn("mt-4 text-sm text-muted-foreground", className)} {...props} />
));
TableCaption.displayName = "TableCaption";

const TableRow = React.forwardRef<
  HTMLTableRowElement,
  HTMLMotionProps<"tr"> & {
    animateInsertion?: boolean;
    noHover?: boolean;
    isHeader?: boolean;
    index?: number;
    height?: number;
  }
>(
  (
    { animateInsertion, className, height = 33, noHover, isHeader = false, index = 0, ...props },
    ref
  ) => {
    // Shorter duration for rows further down, to avoid them taking forever to animate in.
    const delay = React.useMemo(() => {
      // Start with minimal delay and increase logarithmically
      const baseDelay = 0.08;
      const maxDelay = 0.5;
      return Math.min(baseDelay + Math.log10(index + 1) * 0.08, maxDelay);
    }, [index]);

    return (
      <motion.tr
        initial={{
          backgroundColor: "rgba(0, 160, 106, 0)",
          y: animateInsertion ? "-100%" : undefined,
          opacity: 0,
        }}
        animate={{
          opacity: 1,
          x: 0,
          y: 0,
          transition: {
            opacity: {
              type: "just",
              delay,
            },
            y: { type: "just", delay: 0.05 },
          },
        }}
        whileHover={
          !isHeader
            ? {
                backgroundColor: "rgba(0, 160, 106, 0.05)",
                transition: { backgroundColor: { duration: 0.12 } },
              }
            : {}
        }
        ref={ref}
        style={{ height, ...props.style }}
        className={cn(
          "relative w-full",
          !isHeader && !noHover ? "transition-colors group" : "",
          className
        )}
        {...props}
      >
        {props.children as React.ReactNode}
      </motion.tr>
    );
  }
);
TableRow.displayName = "TableRow";

export { Table, TableBody, TableCell, TableHead, TableHeader, TableRow };
