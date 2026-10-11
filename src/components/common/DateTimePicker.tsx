import { useState, type CSSProperties } from 'react';
import {
  Button,
  Calendar,
  CalendarCell,
  CalendarGrid,
  CalendarGridBody,
  CalendarGridHeader,
  CalendarHeaderCell,
  CalendarHeading,
  CalendarMonthPicker,
  CalendarYearPicker,
  DateField,
  DateInput,
  DateSegment,
  Dialog,
  DialogTrigger,
  I18nProvider,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Select,
  SelectValue,
  TimeField
} from 'react-aria-components';
import type { CalendarMonthPickerAria } from 'react-aria-components/Calendar';
import {
  CalendarDate,
  Time,
  getLocalTimeZone,
  now,
  parseDate,
  parseDateTime,
  toCalendarDate,
  toCalendarDateTime,
  toTime
} from '@internationalized/date';
import Icon from './Icon';
import { t } from '../../i18n/zh';
import './DateTimePicker.css';

export interface DateTimePickerProps {
  /** 本地日期 YYYY-MM-DD，或本地日期时间 YYYY-MM-DDTHH:mm，不进行 UTC 转换。 */
  value: string;
  onChange: (value: string) => void;
  mode?: 'date' | 'datetime';
  ariaLabel: string;
  minValue?: string;
  maxValue?: string;
  disabled?: boolean;
  clearable?: boolean;
  className?: string;
}

const focusClass =
  'outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-od-accent';
const smallButtonClass = `flex h-8 items-center justify-center gap-2 rounded-md px-2 text-xs text-od-text hover:bg-od-bg-hover disabled:opacity-30 ${focusClass}`;
const segmentClass =
  'rounded px-0.5 tabular-nums outline-none focus:bg-od-accent/20 focus:text-od-accent data-[placeholder]:text-od-text-dim';
const noDrag = { WebkitAppRegion: 'no-drag' } as CSSProperties;

function readValue(value: string) {
  try {
    return value.includes('T') ? parseDateTime(value) : parseDate(value);
  } catch {
    return null;
  }
}

function readBound(value: string, withTime: boolean, end: boolean) {
  const parsed = readValue(value);
  if (!parsed) return null;
  if (!withTime) return toCalendarDate(parsed);
  return 'hour' in parsed
    ? parsed
    : toCalendarDateTime(parsed, end ? new Time(23, 59) : new Time());
}

/** 年/月菜单和日历共享焦点管理，避免嵌套浮层抢焦点或被父层裁切。 */
function CalendarSelect({ items, ...props }: CalendarMonthPickerAria) {
  return (
    <Select {...props} className="min-w-0">
      <Button className={smallButtonClass}>
        <SelectValue />
        <Icon name="chevronDown" className="w-2.5 text-od-text-dim" />
      </Button>
      <Popover
        placement="bottom start"
        offset={4}
        className="date-time-picker-popover z-[110] flex min-w-24 flex-col overflow-hidden rounded-lg border border-od-border-light bg-od-bg-alt shadow-xl"
        style={noDrag}
      >
        <ListBox items={items} className="max-h-56 overflow-y-auto p-1 outline-none">
          {(item) => (
            <ListBoxItem
              id={item.id}
              textValue={item.formatted}
              className="cursor-default rounded px-3 py-1.5 text-xs text-od-text outline-none data-[focused]:bg-od-bg-hover data-[selected]:text-od-accent"
            >
              {item.formatted}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </Select>
  );
}

/**
 * 主题化日期/日期时间选择器。日历和分段输入只修改草稿，确定后才通知调用方；
 * 取消、Esc、点击外部均丢弃草稿，避免统计等昂贵操作在编辑期间重复执行。
 */
export default function DateTimePicker({
  value,
  onChange,
  mode = 'date',
  ariaLabel,
  minValue = '1970-01-01',
  maxValue = '9999-12-31',
  disabled = false,
  clearable = false,
  className = ''
}: DateTimePickerProps) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState<CalendarDate | null>(null);
  const [time, setTime] = useState<Time | null>(null);
  const [focusedDate, setFocusedDate] = useState<CalendarDate>();
  const selected = readValue(value);
  const withTime = mode === 'datetime';
  const min = readBound(minValue, withTime, false);
  const max = readBound(maxValue, withTime, true);
  const draft = date && (withTime ? (time ? toCalendarDateTime(date, time) : null) : date);
  const local = draft?.toDate(getLocalTimeZone());
  const exists =
    !draft ||
    !('hour' in draft) ||
    (local?.getHours() === draft.hour && local?.getMinutes() === draft.minute);
  const valid = Boolean(
    draft && exists && (!min || draft.compare(min) >= 0) && (!max || draft.compare(max) <= 0)
  );
  const display = selected
    ? `${toCalendarDate(selected).toString().replaceAll('-', '/')}${withTime ? ` ${'hour' in selected ? toTime(selected).toString().slice(0, 5) : '00:00'}` : ''}`
    : withTime
      ? t.datePickerChooseDateTime
      : t.datePickerChooseDate;

  const setOpenState = (next: boolean) => {
    if (next) {
      const initial = selected ?? now(getLocalTimeZone());
      const initialDate = toCalendarDate(initial);
      setDate(initialDate);
      setTime('hour' in initial ? toTime(initial).set({ second: 0, millisecond: 0 }) : new Time());
      setFocusedDate(initialDate);
    }
    setOpen(next);
  };

  const chooseNow = () => {
    const current = now(getLocalTimeZone());
    setDate(toCalendarDate(current));
    setFocusedDate(toCalendarDate(current));
    setTime(toTime(current).set({ second: 0, millisecond: 0 }));
  };

  const confirm = () => {
    if (!draft || !valid) return;
    onChange(withTime ? draft.toString().slice(0, 16) : draft.toString());
    setOpen(false);
  };

  return (
    <I18nProvider locale="zh-CN">
      <DialogTrigger isOpen={open} onOpenChange={setOpenState}>
        <Button
          aria-label={ariaLabel}
          isDisabled={disabled}
          className={`flex h-9 min-w-0 items-center justify-between gap-2 rounded-md border border-od-border-light bg-od-bg px-3 text-xs tabular-nums text-od-text transition-colors hover:bg-od-bg-hover disabled:opacity-40 ${focusClass} ${className}`}
        >
          <span className="truncate">{display}</span>
          <Icon name="calendar" className="w-3 shrink-0 text-od-text-dim" />
        </Button>
        <Popover
          placement="bottom start"
          offset={6}
          containerPadding={12}
          className="date-time-picker-popover z-[100] flex w-80 max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-xl border border-od-border-light bg-od-bg-alt shadow-xl"
          style={noDrag}
        >
          <Dialog
            aria-label={ariaLabel}
            className="flex min-h-0 flex-col overflow-hidden p-3 outline-none"
          >
            <div className="mb-3 flex shrink-0 items-center justify-between gap-2 border-b border-od-border pb-3">
              <div className="text-sm font-medium text-od-text-bright">{ariaLabel}</div>
              <Button
                onPress={() => setOpen(false)}
                aria-label={t.cancel}
                className={smallButtonClass}
              >
                <Icon name="close" className="w-3" />
              </Button>
            </div>
            <div className="min-h-0 overflow-y-auto">
              <Calendar
                aria-label={t.datePickerCalendar}
                value={date}
                onChange={setDate}
                focusedValue={focusedDate}
                onFocusChange={setFocusedDate}
                minValue={min ? toCalendarDate(min) : undefined}
                maxValue={max ? toCalendarDate(max) : undefined}
                firstDayOfWeek="mon"
                autoFocus
              >
                <CalendarHeading className="sr-only" />
                <div className="mb-2 flex items-center justify-between gap-1">
                  <Button slot="previous" className={smallButtonClass}>
                    <Icon name="chevronLeft" className="w-3" />
                  </Button>
                  <div className="flex items-center gap-1">
                    <CalendarYearPicker visibleYears={201}>
                      {(props) => (
                        <CalendarSelect
                          {...props}
                          onChange={(key) => {
                            const year = props.items.find((item) => item.id === key)?.date.year;
                            if (!year || !focusedDate) return;
                            // 切换年份时保留月份，闰年 2 月 29 日自动收敛至有效日期。
                            let next = focusedDate.set({ year });
                            if (min && next.compare(toCalendarDate(min)) < 0)
                              next = toCalendarDate(min);
                            if (max && next.compare(toCalendarDate(max)) > 0)
                              next = toCalendarDate(max);
                            setFocusedDate(next);
                          }}
                        />
                      )}
                    </CalendarYearPicker>
                    <CalendarMonthPicker>
                      {(props) => <CalendarSelect {...props} />}
                    </CalendarMonthPicker>
                  </div>
                  <Button slot="next" className={smallButtonClass}>
                    <Icon name="chevronRight" className="w-3" />
                  </Button>
                </div>
                <CalendarGrid weekdayStyle="short" className="w-full table-fixed border-collapse">
                  <CalendarGridHeader>
                    {(day) => (
                      <CalendarHeaderCell className="pb-2 text-center text-xs font-normal text-od-text-dim">
                        {day}
                      </CalendarHeaderCell>
                    )}
                  </CalendarGridHeader>
                  <CalendarGridBody>
                    {(day) => (
                      <CalendarCell
                        date={day}
                        className={({ isSelected, isOutsideMonth, isDisabled, isToday }) =>
                          `mx-auto flex h-9 w-full max-w-9 cursor-default items-center justify-center rounded-md text-xs tabular-nums outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-inset data-[focus-visible]:ring-od-accent ${
                            isSelected
                              ? 'bg-od-accent/20 font-semibold text-od-accent'
                              : isOutsideMonth
                                ? 'text-od-text-dim/50'
                                : 'text-od-text'
                          } ${isDisabled ? 'opacity-30' : 'hover:bg-od-bg-hover'} ${isToday ? 'border border-od-accent/60' : ''}`
                        }
                      />
                    )}
                  </CalendarGridBody>
                </CalendarGrid>
              </Calendar>

              <div className="mt-3 flex flex-wrap gap-2 border-t border-od-border pt-3">
                <DateField
                  aria-label={t.datePickerDate}
                  value={date}
                  onChange={(next) => {
                    setDate(next);
                    if (next) setFocusedDate(next);
                  }}
                  minValue={min ? toCalendarDate(min) : undefined}
                  maxValue={max ? toCalendarDate(max) : undefined}
                  shouldForceLeadingZeros
                  className="min-w-0 flex-1"
                >
                  <Label className="mb-1 block text-xs text-od-text-dim">{t.datePickerDate}</Label>
                  <DateInput className="flex h-9 items-center justify-center rounded-md border border-od-border-light bg-od-bg px-2 text-xs text-od-text focus-within:border-od-accent data-[invalid]:border-od-red">
                    {(segment) => <DateSegment segment={segment} className={segmentClass} />}
                  </DateInput>
                </DateField>
                {withTime && (
                  <TimeField
                    aria-label={t.datePickerTime}
                    value={time}
                    onChange={setTime}
                    hourCycle={24}
                    granularity="minute"
                    shouldForceLeadingZeros
                    className="min-w-24"
                  >
                    <Label className="mb-1 block text-xs text-od-text-dim">
                      {t.datePickerTime}
                    </Label>
                    <DateInput className="flex h-9 items-center justify-center rounded-md border border-od-border-light bg-od-bg px-2 text-xs text-od-text focus-within:border-od-accent">
                      {(segment) => <DateSegment segment={segment} className={segmentClass} />}
                    </DateInput>
                  </TimeField>
                )}
              </div>
              <p
                className={`mt-2 text-xs ${valid ? 'text-od-text-dim' : 'text-od-red'}`}
                role={valid ? undefined : 'status'}
              >
                {valid
                  ? withTime
                    ? t.datePickerTimeHint
                    : t.datePickerDateHint
                  : t.datePickerInvalid}
              </p>
            </div>
            <div className="mt-3 flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-od-border pt-3">
              <div className="flex items-center gap-1">
                <Button onPress={chooseNow} className={smallButtonClass}>
                  {withTime ? t.datePickerNow : t.datePickerToday}
                </Button>
                {clearable && (
                  <Button
                    onPress={() => {
                      onChange('');
                      setOpen(false);
                    }}
                    className={smallButtonClass}
                  >
                    {t.datePickerClear}
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-1">
                <Button onPress={() => setOpen(false)} className={smallButtonClass}>
                  {t.cancel}
                </Button>
                <Button
                  onPress={confirm}
                  isDisabled={!valid}
                  className={`h-8 rounded-md bg-od-accent/20 px-3 text-xs font-medium text-od-accent hover:bg-od-accent/30 disabled:opacity-40 ${focusClass}`}
                >
                  {t.confirm}
                </Button>
              </div>
            </div>
          </Dialog>
        </Popover>
      </DialogTrigger>
    </I18nProvider>
  );
}
