type DateRangeFormProps = {
  fromDate: string;
  toDate: string;
};

export function DateRangeForm({ fromDate, toDate }: DateRangeFormProps) {
  return (
    <form className="date-form">
      <label>
        <span>From</span>
        <input name="fromDate" type="date" defaultValue={fromDate} />
      </label>
      <label>
        <span>To</span>
        <input name="toDate" type="date" defaultValue={toDate} />
      </label>
      <button type="submit">Apply</button>
    </form>
  );
}
