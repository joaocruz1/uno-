"use client";

import { forwardRef, type InputHTMLAttributes } from "react";

import { maskBrPhone } from "@/lib/phone";

type PhoneInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> & {
  value: string;
  onValueChange(value: string): void;
};

/**
 * Brazilian phone field with a live "(11) 98765-4321" mask. The server validates
 * and normalizes to E.164; this only shapes what is typed.
 */
export const PhoneInput = forwardRef<HTMLInputElement, PhoneInputProps>(function PhoneInput({ value, onValueChange, ...props }, ref) {
  return (
    <input
      ref={ref}
      type="tel"
      inputMode="tel"
      autoComplete="tel-national"
      placeholder="(11) 98765-4321"
      {...props}
      value={value}
      onChange={(event) => onValueChange(maskBrPhone(event.target.value))}
    />
  );
});
