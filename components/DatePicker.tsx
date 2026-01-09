import React, { useState } from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet, Pressable, FlatList, Platform } from 'react-native';
import { Calendar as CalendarIcon, X as XIcon } from 'lucide-react-native';
import { formatDateToString } from '../lib/utils';

export interface DatePickerProps {
  selectedDate?: string;
  onSelect: (date: string) => void;
  theme: any;
  placeholder?: string;
  allowFutureDates?: boolean;
  clearable?: boolean;
  onClear?: () => void;
}

export default function DatePicker({ selectedDate = '', onSelect, theme, placeholder = 'Select date', allowFutureDates = true, clearable = true, onClear }: DatePickerProps) {
  const [showOptions, setShowOptions] = useState(false);
  const [currentMonth, setCurrentMonth] = useState(new Date(selectedDate || Date.now()));
  const [showMonthPicker, setShowMonthPicker] = useState(false);
  const [showYearPicker, setShowYearPicker] = useState(false);

  const formatPretty = (dateString: string) => {
    if (!dateString) return '';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  };

  const generateCalendarDays = () => {
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startDate = new Date(firstDay);
    const endDate = new Date(lastDay);
    startDate.setDate(startDate.getDate() - startDate.getDay());
    endDate.setDate(endDate.getDate() + (6 - endDate.getDay()));
    const days: Date[] = [];
    const cur = new Date(startDate);
    while (cur <= endDate) {
      days.push(new Date(cur));
      cur.setDate(cur.getDate() + 1);
    }
    return days;
  };

  const generateYearRange = () => {
    const currentYear = new Date().getFullYear();
    const years: number[] = [];
    for (let y = currentYear; y >= 1900; y--) years.push(y);
    for (let y = currentYear + 1; y <= currentYear + 20; y++) years.push(y);
    return years;
  };

  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

  const isSelectedDate = (date: Date) => {
    if (!selectedDate) return false;
    const sel = new Date(selectedDate);
    return date.toDateString() === sel.toDateString();
  };

  const isCurrentMonth = (date: Date) => date.getMonth() === currentMonth.getMonth();

  const isFutureDate = (date: Date) => {
    const today = new Date();
    const d0 = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    return d0 > t0;
  };

  const handleDateSelect = (date: Date) => {
    if (!allowFutureDates && isFutureDate(date)) return;
    const dateString = formatDateToString(date);
    onSelect(dateString);
    setShowOptions(false);
  };

  const navigateMonth = (direction: 'prev' | 'next') => {
    const nm = new Date(currentMonth);
    nm.setMonth(nm.getMonth() + (direction === 'prev' ? -1 : 1));
    setCurrentMonth(nm);
  };

  const handleMonthSelect = (monthIndex: number) => {
    const nm = new Date(currentMonth);
    nm.setMonth(monthIndex);
    setCurrentMonth(nm);
    setShowMonthPicker(false);
  };

  const handleYearSelect = (year: number) => {
    const nm = new Date(currentMonth);
    nm.setFullYear(year);
    setCurrentMonth(nm);
    setShowYearPicker(false);
  };

  return (
    <View>
      <TouchableOpacity
        style={[styles.datePickerButton, { borderColor: theme.border, backgroundColor: theme.surface }]}
        onPress={() => setShowOptions(!showOptions)}
        activeOpacity={0.8}
      >
        <CalendarIcon size={14} color={theme.textSecondary} />
        <Text style={[styles.datePickerText, { color: selectedDate ? theme.text : theme.textSecondary }]} numberOfLines={1}>
          {selectedDate ? formatPretty(selectedDate) : placeholder}
        </Text>
        {clearable && !!selectedDate && (
          <TouchableOpacity
            onPress={(e) => {
              // prevent parent button from toggling modal
              // @ts-ignore
              e?.stopPropagation?.();
              if (onClear) onClear();
              else onSelect('');
            }}
            style={[styles.clearBadge, { borderColor: theme.border, backgroundColor: theme.card }]}
            accessibilityRole="button"
            accessibilityLabel="Clear date"
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          >
            <XIcon size={12} color={theme.textSecondary} />
          </TouchableOpacity>
        )}
      </TouchableOpacity>

      {showOptions && (
        <Modal visible transparent animationType="fade" onRequestClose={() => setShowOptions(false)}>
          <Pressable
            style={styles.modalOverlay}
            onPress={() => {
              setShowOptions(false);
              setShowMonthPicker(false);
              setShowYearPicker(false);
            }}
          >
            <Pressable style={[styles.datePickerModal, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              {/* Header */}
              <View style={styles.datePickerHeader}>
                <TouchableOpacity style={styles.monthNavButton} onPress={() => navigateMonth('prev')}>
                  <Text style={[styles.monthNavText, { color: theme.primary }]}>‹</Text>
                </TouchableOpacity>

                <View style={styles.monthYearContainer}>
                  <TouchableOpacity
                    style={[styles.monthYearButton, { borderColor: theme.border }]}
                    onPress={() => {
                      setShowMonthPicker(true);
                      setShowYearPicker(false);
                    }}
                  >
                    <Text style={[styles.monthYearButtonText, { color: theme.text }]}>
                      {currentMonth.toLocaleDateString('en-US', { month: 'long' })}
                    </Text>
                    <Text style={[styles.dropdownArrow, { color: theme.textSecondary }]}>▼</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.monthYearButton, { borderColor: theme.border }]}
                    onPress={() => {
                      setShowYearPicker(true);
                      setShowMonthPicker(false);
                    }}
                  >
                    <Text style={[styles.monthYearButtonText, { color: theme.text }]}>
                      {currentMonth.getFullYear()}
                    </Text>
                    <Text style={[styles.dropdownArrow, { color: theme.textSecondary }]}>▼</Text>
                  </TouchableOpacity>
                </View>

                <TouchableOpacity style={styles.monthNavButton} onPress={() => navigateMonth('next')}>
                  <Text style={[styles.monthNavText, { color: theme.primary }]}>›</Text>
                </TouchableOpacity>
              </View>

              {/* Month Picker */}
              {showMonthPicker && (
                <View style={[styles.pickerDropdown, { backgroundColor: theme.background, borderColor: theme.border }]}> 
                  <View style={[styles.pickerHeader, { borderBottomColor: theme.border }]}>
                    <Text style={[styles.pickerHeaderText, { color: theme.text }]}>Select Month</Text>
                    <TouchableOpacity style={[styles.pickerCloseButton, { backgroundColor: theme.primary + '15' }]} onPress={() => setShowMonthPicker(false)}>
                      <Text style={[styles.pickerCloseText, { color: theme.primary }]}>✕</Text>
                    </TouchableOpacity>
                  </View>
                  <FlatList
                    data={months}
                    keyExtractor={(_, index) => index.toString()}
                    style={[styles.pickerScrollView, { backgroundColor: theme.background }]}
                    contentContainerStyle={styles.pickerScrollContent}
                    showsVerticalScrollIndicator
                    nestedScrollEnabled={Platform.OS === 'android'}
                    keyboardShouldPersistTaps="handled"
                    bounces={Platform.OS === 'ios'}
                    overScrollMode={Platform.OS === 'android' ? 'always' : undefined}
                    renderItem={({ item, index }) => (
                      <TouchableOpacity
                        style={[styles.pickerItem, { backgroundColor: currentMonth.getMonth() === index ? theme.primary + '20' : theme.surface }]}
                        onPress={() => handleMonthSelect(index)}
                        activeOpacity={0.7}
                      >
                        <Text style={[styles.pickerItemText, { color: currentMonth.getMonth() === index ? theme.primary : theme.text, fontWeight: currentMonth.getMonth() === index ? '600' as const : '400' as const }]}>
                          {item}
                        </Text>
                      </TouchableOpacity>
                    )}
                  />
                </View>
              )}

              {/* Year Picker */}
              {showYearPicker && (
                <View style={[styles.pickerDropdown, { backgroundColor: theme.background, borderColor: theme.border }]}> 
                  <View style={[styles.pickerHeader, { borderBottomColor: theme.border }]}>
                    <Text style={[styles.pickerHeaderText, { color: theme.text }]}>Select Year</Text>
                    <TouchableOpacity style={[styles.pickerCloseButton, { backgroundColor: theme.primary + '15' }]} onPress={() => setShowYearPicker(false)}>
                      <Text style={[styles.pickerCloseText, { color: theme.primary }]}>✕</Text>
                    </TouchableOpacity>
                  </View>
                  <FlatList
                    data={generateYearRange()}
                    keyExtractor={(item) => item.toString()}
                    style={[styles.pickerScrollView, { backgroundColor: theme.background }]}
                    contentContainerStyle={styles.pickerScrollContent}
                    showsVerticalScrollIndicator
                    nestedScrollEnabled={Platform.OS === 'android'}
                    keyboardShouldPersistTaps="handled"
                    bounces={Platform.OS === 'ios'}
                    overScrollMode={Platform.OS === 'android' ? 'always' : undefined}
                    renderItem={({ item }) => (
                      <TouchableOpacity
                        style={[styles.pickerItem, { backgroundColor: currentMonth.getFullYear() === item ? theme.primary + '20' : theme.surface }]}
                        onPress={() => handleYearSelect(item)}
                        activeOpacity={0.7}
                      >
                        <Text style={[styles.pickerItemText, { color: currentMonth.getFullYear() === item ? theme.primary : theme.text, fontWeight: currentMonth.getFullYear() === item ? '600' as const : '400' as const }]}>
                          {item}
                        </Text>
                      </TouchableOpacity>
                    )}
                  />
                </View>
              )}

              {/* Calendar grid */}
              {!showMonthPicker && !showYearPicker && (
                <View>
                  <View style={styles.daysOfWeekRow}>
                    {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => (
                      <Text key={d} style={[styles.dayOfWeekText, { color: theme.textSecondary }]}>{d}</Text>
                    ))}
                  </View>
                  <View style={styles.calendarGrid}>
                    {generateCalendarDays().map((date, index) => {
                      const disabled = !allowFutureDates && isFutureDate(date);
                      return (
                        <TouchableOpacity
                          key={index}
                          style={[styles.calendarDay, { backgroundColor: isSelectedDate(date) ? theme.primary : 'transparent', opacity: isCurrentMonth(date) ? (disabled ? 0.3 : 1) : 0.3 }]}
                          onPress={() => handleDateSelect(date)}
                          disabled={disabled}
                        >
                          <Text style={[styles.calendarDayText, { color: isSelectedDate(date) ? '#ffffff' : (disabled ? theme.textSecondary : theme.text), fontWeight: isSelectedDate(date) ? '600' : '400' }]}>
                            {date.getDate()}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              )}
            </Pressable>
          </Pressable>
        </Modal>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  datePickerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    gap: 6,
    height: 32,
  },
  datePickerText: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '500',
  },
  clearBadge: {
    marginLeft: 6,
    width: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  datePickerModal: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 20,
    width: 320,
    maxWidth: '90%',
    borderWidth: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 8,
  },
  datePickerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  monthNavButton: {
    width: 32,
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
  monthNavText: {
    fontSize: 24,
    fontWeight: '600',
  },
  monthYearContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
    justifyContent: 'center',
  },
  monthYearButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderRadius: 6,
    minWidth: 80,
    justifyContent: 'center',
    gap: 4,
  },
  monthYearButtonText: {
    fontSize: 14,
    fontWeight: '500',
  },
  dropdownArrow: {
    fontSize: 10,
    marginLeft: 4,
  },
  pickerDropdown: {
    marginTop: 16,
    borderWidth: 1,
    borderRadius: 8,
    height: 280,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 8,
  },
  pickerScrollView: {
    flex: 1,
    height: 220,
  },
  pickerScrollContent: {
    paddingVertical: 8,
  },
  pickerItem: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 0.5,
    borderBottomColor: 'rgba(0,0,0,0.1)',
  },
  pickerItemText: {
    fontSize: 14,
    textAlign: 'center',
  },
  pickerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  pickerHeaderText: {
    fontSize: 16,
    fontWeight: '600',
  },
  pickerCloseButton: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pickerCloseText: {
    fontSize: 12,
    fontWeight: '700',
  },
  daysOfWeekRow: {
    flexDirection: 'row',
    marginBottom: 8,
  },
  dayOfWeekText: {
    flex: 1,
    textAlign: 'center',
    fontSize: 12,
    fontWeight: '600',
    paddingVertical: 4,
  },
  calendarGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  calendarDay: {
    width: '14.28%',
    aspectRatio: 1,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 8,
  },
  calendarDayText: {
    fontSize: 14,
  },
});
