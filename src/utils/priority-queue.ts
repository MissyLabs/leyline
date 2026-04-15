export enum MessagePriority {
  CRITICAL = 0,
  HIGH = 1,
  NORMAL = 2,
  LOW = 3,
}

interface PQEntry<T> {
  priority: number;
  seqNo: number;
  value: T;
}

/**
 * Bounded min-heap priority queue. Lower priority number = higher precedence.
 * Ties broken by insertion order (FIFO within same priority).
 */
export class PriorityQueue<T> {
  private heap: PQEntry<T>[] = [];
  private seq = 0;
  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  get length(): number {
    return this.heap.length;
  }

  push(value: T, priority: number = MessagePriority.NORMAL): boolean {
    if (this.heap.length >= this.capacity) {
      const worst = this.peekWorst();
      if (!worst || priority >= worst.priority) return false;
      this.popWorst();
    }
    const entry: PQEntry<T> = { priority, seqNo: this.seq++, value };
    this.heap.push(entry);
    this.bubbleUp(this.heap.length - 1);
    return true;
  }

  pop(): T | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.sinkDown(0);
    }
    return top.value;
  }

  peek(): T | undefined {
    return this.heap[0]?.value;
  }

  clear(): void {
    this.heap.length = 0;
  }

  private peekWorst(): PQEntry<T> | undefined {
    if (this.heap.length === 0) return undefined;
    let worst = this.heap[0];
    const start = Math.floor(this.heap.length / 2);
    for (let i = start; i < this.heap.length; i++) {
      if (this.isLower(worst, this.heap[i])) worst = this.heap[i];
    }
    return worst;
  }

  private popWorst(): void {
    if (this.heap.length <= 1) { this.heap.length = 0; return; }
    let worstIdx = Math.floor(this.heap.length / 2);
    for (let i = worstIdx + 1; i < this.heap.length; i++) {
      if (this.isLower(this.heap[worstIdx], this.heap[i])) worstIdx = i;
    }
    const last = this.heap.pop()!;
    if (worstIdx < this.heap.length) {
      this.heap[worstIdx] = last;
      this.bubbleUp(worstIdx);
      this.sinkDown(worstIdx);
    }
  }

  private isLower(a: PQEntry<T>, b: PQEntry<T>): boolean {
    return a.priority < b.priority || (a.priority === b.priority && a.seqNo < b.seqNo);
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.isLower(this.heap[i], this.heap[parent])) {
        [this.heap[i], this.heap[parent]] = [this.heap[parent], this.heap[i]];
        i = parent;
      } else break;
    }
  }

  private sinkDown(i: number): void {
    const n = this.heap.length;
    while (true) {
      let smallest = i;
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      if (l < n && this.isLower(this.heap[l], this.heap[smallest])) smallest = l;
      if (r < n && this.isLower(this.heap[r], this.heap[smallest])) smallest = r;
      if (smallest === i) break;
      [this.heap[i], this.heap[smallest]] = [this.heap[smallest], this.heap[i]];
      i = smallest;
    }
  }
}
