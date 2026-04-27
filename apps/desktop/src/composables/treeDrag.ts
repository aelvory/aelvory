import { ref } from 'vue';

export interface DraggingNode {
  id: string;
  kind: 'request' | 'collection';
}

// Shared across all TreeNodeItem instances — whichever one started the drag
// owns this while it's active. Cleared on dragend / drop.
export const draggingNode = ref<DraggingNode | null>(null);
