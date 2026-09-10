import { useThree } from "@react-three/fiber";
import { type ReactNode, useLayoutEffect, useRef } from "react";
import * as THREE from "three";

/** Unit geometries every instanced part is scaled from; module singletons so
 * they survive gallery switches and are never disposed by R3F. */
export const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
export const UNIT_PLANE = new THREE.PlaneGeometry(1, 1);

const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _euler = new THREE.Euler();

/** Transform placing a unit geometry: scale to (sx, sy, sz), rotate about x
 * then y, translate to (x, y, z). */
export function placement(
	x: number,
	y: number,
	z: number,
	sx: number,
	sy: number,
	sz: number,
	rotX = 0,
	rotY = 0,
): THREE.Matrix4 {
	return new THREE.Matrix4().compose(
		_position.set(x, y, z),
		_quaternion.setFromEuler(_euler.set(rotX, rotY, 0)),
		_scale.set(sx, sy, sz),
	);
}

/** One InstancedMesh for a repeated part. Matrices are written once when they
 * change; the material is the JSX child so theme colours stay reactive. */
export function Instances({
	geometry,
	matrices,
	castShadow = false,
	receiveShadow = false,
	children,
}: {
	geometry: THREE.BufferGeometry;
	matrices: readonly THREE.Matrix4[];
	castShadow?: boolean;
	receiveShadow?: boolean;
	children: ReactNode;
}) {
	const ref = useRef<THREE.InstancedMesh>(null);
	const invalidate = useThree((s) => s.invalidate);

	useLayoutEffect(() => {
		const mesh = ref.current;
		if (!mesh) return;
		for (let i = 0; i < matrices.length; i++) {
			const m = matrices[i];
			if (m) mesh.setMatrixAt(i, m);
		}
		mesh.instanceMatrix.needsUpdate = true;
		mesh.computeBoundingSphere();
		invalidate();
	}, [matrices, invalidate]);

	if (matrices.length === 0) return null;
	return (
		<instancedMesh
			key={matrices.length}
			ref={ref}
			args={[geometry, undefined, matrices.length]}
			castShadow={castShadow}
			receiveShadow={receiveShadow}
		>
			{children}
		</instancedMesh>
	);
}
