/**
 * Minimal force-directed tag graph for Team Notes.
 *
 * Uses the same stack as Wiki KnowledgeGraph: graphology + Sigma +
 * ForceAtlas2. Nodes are notes (solid) and tags (diamond), edges are
 * `has_tag` links.
 */
import { useEffect, useMemo, useState } from 'react';
import Graph from 'graphology';
import { SigmaContainer, useLoadGraph, useRegisterEvents, useSigma } from '@react-sigma/core';
import '@react-sigma/core/lib/style.css';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import type { NotesGraphData, NotesGraphNode } from '@/lib/notes-api';

interface Props {
  data: NotesGraphData | null;
  onSelectNode?: (node: NotesGraphNode) => void;
  highlightNode?: string | null;
}

const NOTE_COLOR = '#0052d9';
const TAG_COLOR = '#c97700';

function GraphLoader({ data, onSelectNode, highlightNode }: Props) {
  const loadGraph = useLoadGraph();
  const sigma = useSigma();
  const registerEvents = useRegisterEvents();
  const [hovered, setHovered] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    const graph = new Graph();
    const maxLinks = Math.max(...data.nodes.map((n) => n.linkCount), 1);
    for (const node of data.nodes) {
      const size = node.type === 'note'
        ? 7 + Math.pow(node.linkCount / maxLinks, 0.6) * 14
        : 10 + Math.pow(node.linkCount / maxLinks, 0.5) * 10;
      // 不要把业务 node.type 放进 Sigma 的 type 字段：Sigma 会按 type
      // 查找对应的 node program，找不到就会报
      // "could not find a suitable program for node type"。
      graph.addNode(node.id, {
        x: Math.random() * 100,
        y: Math.random() * 100,
        size,
        label: node.label,
        color: node.type === 'note' ? NOTE_COLOR : TAG_COLOR,
        nodeKind: node.type,
      });
    }
    const maxW = Math.max(...data.edges.map((e) => e.weight), 1);
    for (const edge of data.edges) {
      if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
        graph.addEdge(edge.source, edge.target, { size: 0.6 + (edge.weight / maxW) * 1.2, color: '#9aa7b8' });
      }
    }
    const settings = forceAtlas2.inferSettings(graph);
    forceAtlas2.assign(graph, {
      iterations: data.nodes.length > 200 ? 40 : 120,
      settings: { ...settings, gravity: 1.2, scalingRatio: 2.4, strongGravityMode: true, barnesHutOptimize: data.nodes.length > 60 },
    });
    loadGraph(graph);
    sigma.refresh();
  }, [data, loadGraph, sigma]);

  useEffect(() => {
    registerEvents({
      enterNode: (e) => {
        setHovered(e.node);
        const container = sigma.getContainer();
        if (container) container.style.cursor = 'pointer';
      },
      leaveNode: () => {
        setHovered(null);
        const container = sigma.getContainer();
        if (container) container.style.cursor = 'default';
      },
      clickNode: (e) => {
        const node = data?.nodes.find((n) => n.id === e.node);
        if (node && onSelectNode) onSelectNode(node);
      },
    });
  }, [registerEvents, sigma, data, onSelectNode]);

  useEffect(() => {
    sigma.setSetting('nodeReducer', (node, attrs) => {
      const res = { ...attrs };
      if (highlightNode && node === highlightNode) {
        res.highlighted = true;
        res.zIndex = 2;
      }
      if (hovered) {
        if (node === hovered) {
          res.highlighted = true;
          res.zIndex = 2;
          res.size = (attrs.size || 8) * 1.25;
        } else if (highlightNode && node === highlightNode) {
          res.zIndex = 1;
        } else {
          res.color = '#e2e8f0';
        }
      }
      return res;
    });
    sigma.setSetting('edgeReducer', (edge, attrs) => {
      const res = { ...attrs };
      if (hovered) {
        const graph = sigma.getGraph();
        if (graph.source(edge) !== hovered && graph.target(edge) !== hovered) res.hidden = true;
      }
      return res;
    });
    sigma.refresh();
  }, [hovered, highlightNode, sigma]);

  return null;
}

export function NotesGraph({ data, onSelectNode, highlightNode }: Props) {
  const visible = useMemo(() => {
    if (!data) return null;
    const tagDegrees = new Map<string, number>();
    for (const edge of data.edges) {
      tagDegrees.set(edge.target, (tagDegrees.get(edge.target) ?? 0) + 1);
    }
    return {
      nodes: data.nodes,
      edges: data.edges.filter((edge) => (tagDegrees.get(edge.target) ?? 0) >= 1),
    };
  }, [data]);

  if (!visible || visible.nodes.length === 0) {
    return <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">暂无图谱数据</div>;
  }

  return (
    <SigmaContainer style={{ height: 520 }} settings={{ labelRenderedSizeThreshold: 8, labelDensity: 0.2, labelGridCellSize: 90 }}>
      <GraphLoader data={visible} onSelectNode={onSelectNode} highlightNode={highlightNode} />
    </SigmaContainer>
  );
}
