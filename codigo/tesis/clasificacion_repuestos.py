# ============================================================
# IMPORTACIÓN DE LIBRERÍAS Y CONFIGURACIÓN INICIAL
# ============================================================
from IPython.display import display
import random
import pandas as pd
import numpy as np
from itertools import combinations, product
from sklearn.cluster import KMeans
from pymcdm.methods import TOPSIS
from pymcdm.weights import entropy_weights
from scipy.stats import norm
import os
import warnings
from sklearn.exceptions import ConvergenceWarning
import matplotlib

matplotlib.use("TkAgg")
import matplotlib.pyplot as plt
import gc

# Mitigar warnings
warnings.filterwarnings("ignore", category=ConvergenceWarning)
os.environ["OMP_NUM_THREADS"] = "1"
warnings.filterwarnings(
    "ignore",
    message="Alternatives with indices",
    category=UserWarning,
    module="pymcdm.validators"
)


# ============================================================
# DEFINICIÓN DE FUNCIONES (CODIGO 1)
# ============================================================

def generate_data(caracteristicas, num_samples=1000, seed=42):
    random.seed(seed)
    np.random.seed(seed)
    df = pd.DataFrame({
        caracteristica: np.random.randint(min_val, max_val, num_samples)
        for caracteristica, min_val, max_val in caracteristicas
    })
    df['ID'] = range(1, num_samples + 1)
    return df


def calcular_S_s(h, d, R, L, sigma_d, k, service_level):
    z = norm.ppf(service_level)
    sigma_x = sigma_d * np.sqrt(R + L)
    S_s = (d * (R + L)) + int(z * sigma_x)
    return S_s


def total_cost_RS(h, d, R, L, sigma_d, k, b, service_level):
    S_s = calcular_S_s(h, d, R, L, sigma_d, k, service_level)
    holding_cost = h * (d * R / 2 + S_s)
    ordering_cost = k / R
    z = norm.ppf(service_level)
    expected_backorders = sigma_d * np.sqrt(R + L) * norm.pdf(z)
    backorder_cost = b * expected_backorders
    return holding_cost + ordering_cost + backorder_cost


def simular_inventario(R, S, demand_mean, demand_std, lead_time, periods=72, warm_up=12):
    inventory = S
    transit_orders = []
    ciclos_completos = 0
    ciclos_negativos = 0
    meses_con_inventario_negativo_medidos = 0
    inventario_total_negativo_medido = 0
    demanda_total_medida = 0

    for mes in range(1, periods + 1):
        demand = int(np.random.normal(demand_mean, demand_std))
        inventory -= demand

        new_transit_orders = []
        for lt, amount in transit_orders:
            if lt == 1:
                inventory += amount
                ciclos_completos += 1
                if inventory <= 0:
                    ciclos_negativos += 1
            else:
                new_transit_orders.append((lt - 1, amount))
        transit_orders = new_transit_orders

        if mes % R == 0:
            current_transit_inventory = sum(amount for lt, amount in transit_orders)
            order_amount = S - inventory - current_transit_inventory
            if order_amount > 0:
                transit_orders.append((lead_time, order_amount))

        if mes > warm_up:
            if inventory < 0:
                meses_con_inventario_negativo_medidos += 1
                inventario_total_negativo_medido += inventory
            demanda_total_medida += demand

    meses_medidos = periods - warm_up
    inventario_total_negativo_medido = -inventario_total_negativo_medido
    demanda_satisfecha = demanda_total_medida - inventario_total_negativo_medido

    disponibilidad = (meses_medidos - meses_con_inventario_negativo_medidos) / meses_medidos if meses_medidos > 0 else 0
    fill_rate = demanda_satisfecha / demanda_total_medida if demanda_total_medida > 0 else 0
    cycle_sl = (ciclos_completos - ciclos_negativos) / ciclos_completos if ciclos_completos > 0 else 0

    return disponibilidad, cycle_sl, fill_rate


def listar_combinaciones_criterios_atributos(todas_caracteristicas,
                                             min_crit=3, max_crit=4,
                                             min_attr=1, max_attr=1):
    combos = []
    for r in range(min_crit, max_crit + 1):
        for crit_subset in combinations(todas_caracteristicas, r):
            crit_subset = set(crit_subset)
            leftover = set(todas_caracteristicas) - crit_subset
            for s in range(min_attr, max_attr + 1):
                for attr_subset in combinations(leftover, s):
                    combos.append((list(crit_subset), list(attr_subset)))
    return combos


def asignar_politica(clase):
    if clase == 'A':
        return 0.90, 1
    elif clase == 'B':
        return 0.70, 4
    else:
        return 0.50, 5


def apply_topsis_policy_simulation(sub_df, crit_comb):
    types = np.array([1] * len(crit_comb), dtype=int)
    decision_matrix = sub_df[crit_comb].to_numpy()

    weights = entropy_weights(decision_matrix)
    topsis_scores = TOPSIS()(decision_matrix, weights, types)
    sub_df['Score TOPSIS'] = topsis_scores

    # Umbrales para A-B-C
    clase_a_threshold, clase_b_threshold = np.percentile(topsis_scores, [80, 50])
    sub_df['Tipo Clase'] = pd.cut(
        topsis_scores,
        bins=[-np.inf, clase_b_threshold, clase_a_threshold, np.inf],
        labels=['C', 'B', 'A']
    )

    def aplicar_politica_fila(row):
        service_level, R = asignar_politica(row['Tipo Clase'])
        sigma_d = row['C8']
        s_s = calcular_S_s(row['C5'], row['C1'], R, row['C3'], sigma_d, row['C4'], service_level)
        cost = total_cost_RS(row['C5'], row['C1'], R, row['C3'], sigma_d, row['C4'], row['C6'], service_level)
        return cost, s_s, R, service_level

    sub_df[['total_cost', 'S_s', 'R', 'service_level']] = sub_df.apply(
        aplicar_politica_fila, axis=1, result_type='expand'
    )

    def simular_fila(row):
        disp, cycle_sl, fill_rate = simular_inventario(
            row['R'], row['S_s'],
            row['C1'], row['C8'],
            row['C3'],
            periods=76,
            warm_up=12
        )
        return pd.Series({'Disponibilidad': disp, 'Cycle_sl': cycle_sl, 'Fill Rate': fill_rate})

    sub_df[['Disponibilidad', 'Cycle_sl', 'Fill Rate']] = sub_df.apply(simular_fila, axis=1)

    metrica = {
        "total_cost_sum": sub_df['total_cost'].sum(),
        "Disponibilidad_promedio": sub_df['Disponibilidad'].mean(),
        "Cycle_sl_promedio": sub_df['Cycle_sl'].mean(),
        "Fill_rate_promedio": sub_df['Fill Rate'].mean()
    }
    return sub_df, metrica


def clasificar_combinaciones(df, combos_crit_attr, k_values=(1, 2, 3, 4, 5)):
    resultados_minimos = []
    total_configs = len(combos_crit_attr) * len(k_values)

    for (crit_comb, attr_comb) in combos_crit_attr:
        for k in k_values:
            if k == 1:
                df_temp = df.copy()
                cluster_df, metrica = apply_topsis_policy_simulation(df_temp, crit_comb)
                resultados_minimos.append({
                    "k": k,
                    "criterios": crit_comb,
                    "atributos": attr_comb,
                    "cluster_num": 1,
                    "total_cost": metrica["total_cost_sum"],
                    "Disponibilidad_promedio": metrica["Disponibilidad_promedio"],
                    "Cycle_sl_promedio": metrica["Cycle_sl_promedio"],
                    "Fill_rate_promedio": metrica["Fill_rate_promedio"],
                    "assigned_ids": set(cluster_df["ID"].unique())
                })
                del df_temp, cluster_df, metrica
            else:
                if len(attr_comb) == 0:
                    continue
                df_temp = df.copy()
                kmeans = KMeans(n_clusters=k, n_init=20, random_state=42)
                clusters = kmeans.fit_predict(df_temp[attr_comb])
                df_temp['Cluster'] = clusters

                for cluster_num in range(k):
                    cluster_df = df_temp[df_temp['Cluster'] == cluster_num].copy()
                    if cluster_df.empty:
                        continue
                    cluster_df, metrica = apply_topsis_policy_simulation(cluster_df, crit_comb)
                    resultados_minimos.append({
                        "k": k,
                        "criterios": crit_comb,
                        "atributos": attr_comb,
                        "cluster_num": cluster_num + 1,
                        "total_cost": metrica["total_cost_sum"],
                        "Disponibilidad_promedio": metrica["Disponibilidad_promedio"],
                        "Cycle_sl_promedio": metrica["Cycle_sl_promedio"],
                        "Fill_rate_promedio": metrica["Fill_rate_promedio"],
                        "assigned_ids": set(cluster_df["ID"].unique())
                    })
                    del cluster_df, metrica
                del df_temp, clusters, kmeans
            gc.collect()
    return resultados_minimos


# ============================================================
# DEFINICIÓN DE FUNCIONES (CODIGO 2)
# ============================================================

def consolidar_familias_k_atributos(combinaciones, total_ids_set=None, coverage_threshold=1.0):
    listado_combinaciones_unidas = []
    unique_k_attr = {
        (comb['k'], tuple(comb.get('atributos', [])))
        for comb in combinaciones if 'k' in comb
    }

    for (k, atributos_tuple) in unique_k_attr:
        combinaciones_actuales = [
            comb for comb in combinaciones
            if comb['k'] == k and tuple(comb.get('atributos', [])) == atributos_tuple
        ]
        familias_por_cluster = {}
        for comb in combinaciones_actuales:
            cnum = comb['cluster_num']
            familias_por_cluster.setdefault(cnum, []).append(comb)

        if k == 1:
            for comb in combinaciones_actuales:
                assigned_ids = comb.get('assigned_ids', set())
                num_ids = len(assigned_ids)
                cobertura_ok = (num_ids >= int(
                    len(total_ids_set) * coverage_threshold)) if total_ids_set is not None else True
                criterios_str = ','.join(comb.get('criterios', []))
                listado_combinaciones_unidas.append({
                    "K": k,
                    "Atributos": ', '.join(map(str, atributos_tuple)),
                    "Combinación de Familias": f"F1:[{criterios_str}]",
                    "CT (suma de los CT de cada familia)": comb['total_cost'],
                    "FR (promedio)": comb['Fill_rate_promedio'],
                    "CSL (promedio)": comb['Cycle_sl_promedio'],
                    "Av (promedio)": comb['Disponibilidad_promedio'],
                    "IDs Cubiertos": num_ids,
                    "Factible": cobertura_ok
                })
        else:
            if not all(cluster_i in familias_por_cluster for cluster_i in range(1, k + 1)):
                continue
            list_of_lists = [familias_por_cluster[cluster_n] for cluster_n in range(1, k + 1)]
            for fam_combo in product(*list_of_lists):
                all_ids = set()
                solapado = False
                for fam in fam_combo:
                    ids_fam = fam.get('assigned_ids', set())
                    if all_ids & ids_fam:
                        solapado = True
                        break
                    all_ids.update(ids_fam)
                if solapado:
                    continue
                cobertura_ok = (len(all_ids) >= int(
                    len(total_ids_set) * coverage_threshold)) if total_ids_set is not None else True
                total_cost = sum(f.get('total_cost', 0) for f in fam_combo)
                fill_rate_prom = sum(f.get('Fill_rate_promedio', 0) for f in fam_combo) / k
                cycle_sl_prom = sum(f.get('Cycle_sl_promedio', 0) for f in fam_combo) / k
                disp_prom = sum(f.get('Disponibilidad_promedio', 0) for f in fam_combo) / k
                desc_fams = [f"F{f['cluster_num']}:[{','.join(f.get('criterios', []))}]" for f in fam_combo]
                listado_combinaciones_unidas.append({
                    "K": k,
                    "Atributos": ', '.join(map(str, atributos_tuple)),
                    "Combinación de Familias": '; '.join(desc_fams),
                    "CT (suma de los CT de cada familia)": total_cost,
                    "FR (promedio)": fill_rate_prom,
                    "CSL (promedio)": cycle_sl_prom,
                    "Av (promedio)": disp_prom,
                    "IDs Cubiertos": len(all_ids),
                    "Factible": cobertura_ok
                })
    df_consolidado = pd.DataFrame(listado_combinaciones_unidas)
    del listado_combinaciones_unidas, unique_k_attr, combinaciones_actuales, familias_por_cluster
    gc.collect()
    return df_consolidado


# ============================================================
# DEFINICIÓN DE FUNCIONES (CODIGO 3)
# ============================================================

def obtener_mejor_k_por_criterios(df_consolidado, mostrar_tablas=False):
    df_factibles = df_consolidado[df_consolidado["Factible"] == True]
    if df_factibles.empty:
        return {
            "best_k_min_cost": None,
            "best_k_max_fr": None,
            "best_k_max_csl": None,
            "best_k_max_av": None,
            "df_min_cost_per_k": None,
            "df_max_fr_per_k": None,
            "df_max_csl_per_k": None,
            "df_max_av_per_k": None
        }

    df_min_cost_per_k = df_factibles.loc[
        df_factibles.groupby('K')["CT (suma de los CT de cada familia)"].idxmin()
    ]
    df_max_fr_per_k = df_factibles.loc[
        df_factibles.groupby('K')["FR (promedio)"].idxmax()
    ]
    df_max_csl_per_k = df_factibles.loc[
        df_factibles.groupby('K')["CSL (promedio)"].idxmax()
    ]
    df_max_av_per_k = df_factibles.loc[
        df_factibles.groupby('K')["Av (promedio)"].idxmax()
    ]

    best_k_min_cost = df_min_cost_per_k["CT (suma de los CT de cada familia)"].idxmin()
    best_k_max_fr = df_max_fr_per_k["FR (promedio)"].idxmax()
    best_k_max_csl = df_max_csl_per_k["CSL (promedio)"].idxmax()
    best_k_max_av = df_max_av_per_k["Av (promedio)"].idxmax()

    if mostrar_tablas:
        print("\n--- Mejor Costo por cada K ---")
        display(df_min_cost_per_k)
        print("\n--- Mejor Fill Rate por cada K ---")
        display(df_max_fr_per_k)
        print("\n--- Mejor CSL por cada K ---")
        display(df_max_csl_per_k)
        print("\n--- Mejor Disponibilidad por cada K ---")
        display(df_max_av_per_k)

    return {
        "best_k_min_cost": int(df_min_cost_per_k.loc[best_k_min_cost]["K"]),
        "best_k_max_fr": int(df_max_fr_per_k.loc[best_k_max_fr]["K"]),
        "best_k_max_csl": int(df_max_csl_per_k.loc[best_k_max_csl]["K"]),
        "best_k_max_av": int(df_max_av_per_k.loc[best_k_max_av]["K"]),
        "df_min_cost_per_k": df_min_cost_per_k,
        "df_max_fr_per_k": df_max_fr_per_k,
        "df_max_csl_per_k": df_max_csl_per_k,
        "df_max_av_per_k": df_max_av_per_k
    }


# ============================================================
# DEFINICIÓN DE FUNCIONES (CODIGO 4)
# ============================================================

def encontrar_puntos_pareto(df):
    df_ordenado = df.sort_values(
        by=["CT (suma de los CT de cada familia)", "FR (promedio)"],
        ascending=[True, False]
    )
    puntos_pareto = []
    max_fill_rate_actual = -1
    for idx, row in df_ordenado.iterrows():
        if row["FR (promedio)"] > max_fill_rate_actual:
            puntos_pareto.append(idx)
            max_fill_rate_actual = row["FR (promedio)"]
    df_pareto = df.loc[puntos_pareto].copy()
    del df_ordenado, puntos_pareto
    gc.collect()
    return df_pareto


def analizar_criticidad_independiente(row):
    combo_str = row["Combinación de Familias"]
    familias = combo_str.split(";")
    sets_criterios = []
    for fam in familias:
        parte = fam.split(":")
        if len(parte) < 2:
            continue
        criterios_str = parte[1].strip().replace("[", "").replace("]", "")
        criterios_list = [c.strip() for c in criterios_str.split(",") if c.strip() != ""]
        sets_criterios.append(set(criterios_list))
    return len(set(frozenset(s) for s in sets_criterios)) > 1


def generar_graficos_y_resumen_final(dict_semillas_consolidadas, k_values=(1, 2, 3, 4, 5)):
    contador_mejor_cost_k1 = 0
    contador_mejor_fr_k1 = 0
    contador_mejor_csl_k1 = 0
    contador_mejor_av_k1 = 0
    resultados_preguntas_por_semilla = {}
    filas_resumen = []
    todas_semillas = sorted(dict_semillas_consolidadas.keys())

    for idx_semilla, seed_val in enumerate(todas_semillas, start=1):
        df_consolidado = dict_semillas_consolidadas[seed_val]
        df_factibles = df_consolidado[df_consolidado["Factible"] == True].copy()
        if df_factibles.empty:
            continue

        best_criterios = obtener_mejor_k_por_criterios(df_consolidado, mostrar_tablas=False)
        df_pareto = encontrar_puntos_pareto(df_factibles)

        if not df_pareto.empty:
            df_pareto["criticidad_ind"] = df_pareto.apply(analizar_criticidad_independiente, axis=1)
            num_puntos = df_pareto.shape[0]
            num_con_criticidad = df_pareto["criticidad_ind"].sum()
            porcentaje_criticidad = (num_con_criticidad / num_puntos) * 100
        else:
            num_puntos = 0
            num_con_criticidad = 0
            porcentaje_criticidad = 0.0

        conteo_k_pareto = df_pareto["K"].value_counts().to_dict()

        def formato_puntos_k(k):
            cant = conteo_k_pareto.get(k, 0)
            if num_puntos == 0:
                return f"{cant} (0%)"
            porc = (cant / num_puntos) * 100
            return f"{cant} ({porc:.2f}%)"

        df_k1 = df_factibles[df_factibles["K"] == 1]
        cost_k1_min = df_k1["CT (suma de los CT de cada familia)"].min() if not df_k1.empty else np.inf
        fr_k1_max = df_k1["FR (promedio)"].max() if not df_k1.empty else -np.inf
        csl_k1_max = df_k1["CSL (promedio)"].max() if not df_k1.empty else -np.inf
        av_k1_max = df_k1["Av (promedio)"].max() if not df_k1.empty else -np.inf

        df_kmayor1 = df_factibles[df_factibles["K"] > 1]
        cost_kmayor1_min = df_kmayor1["CT (suma de los CT de cada familia)"].min() if not df_kmayor1.empty else np.inf
        fr_kmayor1_max = df_kmayor1["FR (promedio)"].max() if not df_kmayor1.empty else -np.inf
        csl_kmayor1_max = df_kmayor1["CSL (promedio)"].max() if not df_kmayor1.empty else -np.inf
        av_kmayor1_max = df_kmayor1["Av (promedio)"].max() if not df_kmayor1.empty else -np.inf

        peor_ct = "Sí" if cost_kmayor1_min > cost_k1_min else "No"
        peor_fr = "Sí" if fr_kmayor1_max < fr_k1_max else "No"
        peor_csl = "Sí" if csl_kmayor1_max < csl_k1_max else "No"
        peor_av = "Sí" if av_kmayor1_max < av_k1_max else "No"

        resultados_preguntas_por_semilla[seed_val] = {
            "peor_ct": peor_ct,
            "peor_fr": peor_fr,
            "peor_csl": peor_csl,
            "peor_av": peor_av
        }

        if cost_kmayor1_min < cost_k1_min:
            contador_mejor_cost_k1 += 1
        if fr_kmayor1_max > fr_k1_max:
            contador_mejor_fr_k1 += 1
        if csl_kmayor1_max > csl_k1_max:
            contador_mejor_csl_k1 += 1
        if av_kmayor1_max > av_k1_max:
            contador_mejor_av_k1 += 1

        fila = {
            "N° Semilla": seed_val,
            "Puntos eficientes": num_puntos,
            "Puntos eficientes con criticidad independiente": f"{int(num_con_criticidad)} ({porcentaje_criticidad:.2f}%)",
            "Mejor K CT": best_criterios["best_k_min_cost"] if best_criterios["best_k_min_cost"] else "-",
            "Mejor K FR": best_criterios["best_k_max_fr"] if best_criterios["best_k_max_fr"] else "-",
            "Mejor K CSL": best_criterios["best_k_max_csl"] if best_criterios["best_k_max_csl"] else "-",
            "Mejor K AV": best_criterios["best_k_max_av"] if best_criterios["best_k_max_av"] else "-"
        }
        for k in k_values:
            fila[f"K={k}"] = formato_puntos_k(k)
        filas_resumen.append(fila)

        # Guardar y mostrar gráficos solo para las primeras 5 semillas
        if idx_semilla <= 5:
            plt.figure()
            if not df_pareto.empty:
                Ks_unicos = df_pareto["K"].unique()
                marcadores = ['o', 's', '^', 'D', 'v', '*', 'p', 'H']
                for i, k_val in enumerate(Ks_unicos):
                    subset = df_pareto[df_pareto["K"] == k_val]
                    plt.scatter(subset["CT (suma de los CT de cada familia)"],
                                subset["FR (promedio)"],
                                marker=marcadores[i % len(marcadores)],
                                label=f"K={k_val}")
            plt.xlabel("Total Cost (TC)")
            plt.ylabel("Fill Rate (FR)")
            plt.title(f"Pareto Solutions - Seed {seed_val}")
            plt.legend()
            # Guardar el gráfico en un archivo PNG
            nombre_archivo = f"grafico_semilla_{seed_val}.png"
            plt.savefig(nombre_archivo)
            # plt.show()  # Eliminado para no mostrar la ventana
            plt.close()

        del df_factibles, df_k1, df_kmayor1, df_pareto, best_criterios
        gc.collect()

    total_semillas = len(dict_semillas_consolidadas)
    print("\n--- RESULTADO FINAL GLOBAL ---")
    print(
        f"De {total_semillas} semillas, en {contador_mejor_cost_k1} ({(contador_mejor_cost_k1 / total_semillas) * 100:.2f}%) K>1 mejora el CT.")
    print(
        f"De {total_semillas} semillas, en {contador_mejor_fr_k1} ({(contador_mejor_fr_k1 / total_semillas) * 100:.2f}%) K>1 mejora el FR.")
    print(
        f"De {total_semillas} semillas, en {contador_mejor_csl_k1} ({(contador_mejor_csl_k1 / total_semillas) * 100:.2f}%) K>1 mejora el CSL.")
    print(
        f"De {total_semillas} semillas, en {contador_mejor_av_k1} ({(contador_mejor_av_k1 / total_semillas) * 100:.2f}%) K>1 mejora la AV.")

    df_resumen_semillas = pd.DataFrame(filas_resumen)
    del filas_resumen
    gc.collect()
    return df_resumen_semillas, resultados_preguntas_por_semilla


# ============================================================
# BLOQUE PRINCIPAL (CODIGO 5) CON OPTIMIZACIÓN DE MEMORIA
# ============================================================

# Definir características y rangos
todas_caracteristicas = ["C1", "C3", "C4", "C5", "C6", "C8"]
caracteristicas_rangos = [
    ("C1", 600, 1650),  # Demanda
    #("C2", 5000,300000), #Precio CLP
    ("C3", 1, 3),  # Lead time
    ("C4", 20, 1000),  # Costo por ordenar
    ("C5", 3000, 15000),  # Costo de mantenimiento
    ("C6", 30000, 150000),  # Costo de desabastecimiento
    ("C8", 100, 300),  # Desv. estándar
]

# Generar combinaciones de criterios y atributos
combos_crit_attr = listar_combinaciones_criterios_atributos(
    todas_caracteristicas,
    min_crit=3, max_crit=4,
    min_attr=1, max_attr=1
)

# Lista de semillas a procesar
lista_semillas = list(range(1, 2))


# Función para procesar cada semilla y liberar la memoria temporal
def procesar_semilla(seed, combos_crit_attr):
    print(f"\n[INFO] Procesando semilla {seed}...")
    df = generate_data(caracteristicas_rangos, num_samples=1000, seed=seed)
    resultados_minimos = clasificar_combinaciones(df, combos_crit_attr, k_values=(1, 2, 3, 4, 5))
    all_ids = set(df["ID"].unique())
    del df
    gc.collect()
    df_consolidado = consolidar_familias_k_atributos(resultados_minimos, total_ids_set=all_ids, coverage_threshold=1.0)
    del resultados_minimos, all_ids
    gc.collect()
    return df_consolidado


# Procesar cada semilla y almacenar solo el resumen consolidado
dict_semillas_consolidadas = {}
for seed in lista_semillas:
    df_consolidado = procesar_semilla(seed, combos_crit_attr)
    dict_semillas_consolidadas[seed] = df_consolidado
    del df_consolidado
    gc.collect()

# Generar gráficos, frontera de Pareto y resumen final
df_resumen_semillas, preguntas_semilla = generar_graficos_y_resumen_final(dict_semillas_consolidadas,
                                                                          k_values=(1, 2, 3, 4, 5))

# Exportar el resumen global a Excel
df_resumen_semillas.to_excel("Resumen_Global.xlsx", index=False)
print("\n[INFO] Resumen global guardado en 'Resumen_Global.xlsx'.")
display(df_resumen_semillas.head(10))

# Supongamos que ya has generado dict_semillas_consolidadas con la primera semilla procesada.
# Tomamos el DataFrame consolidado de la primer semilla
df_consolidado_primera_semilla = dict_semillas_consolidadas[1]

# Obtenemos los 4 DataFrames del primer seed
resultados_primera_semilla = obtener_mejor_k_por_criterios(
    df_consolidado_primera_semilla,
    mostrar_tablas=False  # en False para que no imprima en pantalla
)

# Extraemos cada tabla
df_min_cost_per_k = resultados_primera_semilla["df_min_cost_per_k"]
df_max_fr_per_k   = resultados_primera_semilla["df_max_fr_per_k"]
df_max_csl_per_k  = resultados_primera_semilla["df_max_csl_per_k"]
df_max_av_per_k   = resultados_primera_semilla["df_max_av_per_k"]

# Guardamos las 4 tablas en un mismo archivo Excel, cada una en su propia hoja
with pd.ExcelWriter("Tablas_PrimerSemilla.xlsx") as writer:
    df_min_cost_per_k.to_excel(writer, sheet_name="Min_Cost_per_K", index=False)
    df_max_fr_per_k.to_excel(writer, sheet_name="Max_FR_per_K", index=False)
    df_max_csl_per_k.to_excel(writer, sheet_name="Max_CSL_per_K", index=False)
    df_max_av_per_k.to_excel(writer, sheet_name="Max_AV_per_K", index=False)

print("Las 4 tablas de la primera semilla se han guardado en 'Tablas_PrimerSemilla.xlsx'.")
